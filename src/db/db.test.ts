import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSettingsStore } from "../settings/store.js";
import { currentMonth, createCostRepo } from "./costs.js";
import type { Db } from "./db.js";
import { createDevTaskRepo } from "./devTasks.js";
import { migrate, migrationsFor } from "./migrations.js";
import { openPostgres, postgresFromPglite, toNumberedParams, type PgliteLike } from "./postgres.js";
import { createReviewRepo } from "./reviews.js";
import { openSqlite } from "./sqlite.js";

/**
 * Mêmes tests sur chaque moteur : SQLite (outil local), PostgreSQL embarqué (PGlite, un vrai moteur
 * PostgreSQL) et, si TEST_DATABASE_URL est défini, un vrai serveur PostgreSQL via le pilote `pg`
 * (la base visée doit avoir « test » dans son nom : elle est vidée au début des tests).
 */
interface Backend {
  name: string;
  open(): Promise<Db>;
}

const backends: Backend[] = [
  { name: "SQLite", open: async () => openSqlite(":memory:") },
  { name: "PostgreSQL (PGlite)", open: async () => postgresFromPglite(new PGlite() as unknown as PgliteLike) },
];

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  backends.push({
    name: "PostgreSQL (serveur réel, pilote pg)",
    async open() {
      if (!/test/i.test(new URL(testUrl).pathname)) throw new Error("TEST_DATABASE_URL doit viser une base dont le nom contient « test » : elle est vidée");
      const db = await openPostgres(testUrl);
      await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      return db;
    },
  });
}

const TABLES_IN_DELETE_ORDER = ["actions", "dev_task_events", "dev_tasks", "reviews", "projects", "settings"];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe("conversion des paramètres", () => {
  it("remplace chaque ? par un paramètre numéroté", () => {
    expect(toNumberedParams("SELECT * FROM t WHERE a = ? AND b IN (?, ?) LIMIT ?")).toBe("SELECT * FROM t WHERE a = $1 AND b IN ($2, $3) LIMIT $4");
    expect(toNumberedParams("SELECT 1")).toBe("SELECT 1");
  });
});

describe.each(backends)("base de données : $name", ({ open }) => {
  let db: Db;
  beforeAll(async () => {
    db = await open();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    for (const table of TABLES_IN_DELETE_ORDER) await db.run(`DELETE FROM ${table}`);
  });

  it("migrations : appliquées une seule fois, version de schéma suivie, relançables", async () => {
    expect(await db.schemaVersion()).toBe(migrationsFor(db.sql).length);
    await migrate(db); // rien à refaire
    expect(await db.schemaVersion()).toBe(migrationsFor(db.sql).length);
    for (const table of TABLES_IN_DELETE_ORDER) expect(await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).toBeTruthy();
  });

  it("transaction : tout ou rien", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO settings (key, value) VALUES ('a', '1')");
        throw new Error("échec au milieu");
      }),
    ).rejects.toThrow("échec au milieu");
    expect(await db.get("SELECT * FROM settings WHERE key = 'a'")).toBeUndefined();

    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO settings (key, value) VALUES ('b', '2')");
    });
    expect(await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'b'")).toEqual({ value: "2" });
  });

  it("reviews : déduplication par commit, statuts, résultat, taux d'accord", async () => {
    const reviews = createReviewRepo(db);
    const base = { projectId: 1, projectPath: "g/p", mrIid: 7, mrTitle: "t", mrUrl: "u", author: "a", headSha: "a".repeat(40) };

    const id = await reviews.insertIfNew(base);
    expect(typeof id).toBe("number");
    expect(await reviews.insertIfNew(base)).toBeNull(); // même commit de la même MR
    const next = await reviews.insertIfNew({ ...base, headSha: "b".repeat(40) });
    expect(next).not.toBeNull();

    expect(await reviews.get(id!)).toMatchObject({ status: "queued", project_path: "g/p", cost_usd: null, error: null });
    expect((await reviews.listInterrupted()).map((r) => r.id).sort()).toEqual([id!, next!].sort());

    await reviews.setStatus(id!, "running");
    await reviews.saveResult(id!, { status: "needs_human", decisionReasons: ["1 point(s) bloquant(s)"], resultJson: "{}", changedLines: 12, costUsd: 0.0222, numTurns: 4 });
    const row = (await reviews.get(id!))!;
    expect(row).toMatchObject({ status: "needs_human", changed_lines: 12, num_turns: 4, error: null });
    expect(row.cost_usd).toBe(0.0222); // un nombre, avec toute sa précision
    expect(row.decision_reasons).toBe('["1 point(s) bloquant(s)"]');
    expect(row.updated_at).toMatch(DATE_FORMAT);

    await reviews.saveError(next!, "boom");
    expect(await reviews.get(next!)).toMatchObject({ status: "error", error: "boom" });
    expect((await reviews.list("error")).map((r) => r.id)).toEqual([next!]);
    expect(await reviews.list(undefined, 1)).toHaveLength(1);

    await reviews.saveFeedback(id!, true, "ok");
    await reviews.saveFeedback(next!, false, null);
    expect(await reviews.agreementStats()).toEqual({ rated: 2, agreed: 1 });
    expect(await reviews.countByStatus()).toEqual({ needs_human: 1, error: 1 });

    await reviews.logAction(id!, "comment", true, "détail");
    expect(await db.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM actions WHERE review_id = ?", [id])).toEqual({ n: 1 });
  });

  it("tâches de dev : création, reprise, mise à jour partielle, journal paginé", async () => {
    const tasks = createDevTaskRepo(db);
    const id = await tasks.insert({ projectId: 1, projectPath: "g/p", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null });
    expect(typeof id).toBe("number");
    expect(await tasks.get(id)).toMatchObject({ status: "queued", mode: "new", parent_id: null, branch: null });
    expect((await tasks.findActive(1, 609))?.id).toBe(id);
    expect(await tasks.findActive(1, 610)).toBeUndefined();

    await tasks.update(id, { status: "running", branch: "feature/609-x", cost_usd: undefined });
    await tasks.update(id, {});
    await tasks.update(id, { status: "mr_created", mr_iid: 12, mr_url: "https://m/12", cost_usd: 0.5, num_turns: 9, files_changed: 3 });
    const done = (await tasks.get(id))!;
    expect(done).toMatchObject({ status: "mr_created", branch: "feature/609-x", mr_iid: 12, cost_usd: 0.5, num_turns: 9, files_changed: 3 });
    expect(done.updated_at).toMatch(DATE_FORMAT);
    expect(await tasks.findActive(1, 609)).toBeUndefined();

    const follow = await tasks.insert({
      projectId: 1, projectPath: "g/p", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: "Ajoute les docblocks",
      followup: { parentId: id, branch: "feature/609-x", baseBranch: "develop", targetBranch: "develop", mrIid: 12, mrUrl: "https://m/12" },
    });
    expect(await tasks.get(follow)).toMatchObject({ mode: "followup", parent_id: id, branch: "feature/609-x", base_branch: "develop", mr_iid: 12 });
    expect((await tasks.latestByIssue()).get("1#609")?.id).toBe(follow);
    expect((await tasks.listInterrupted()).map((t) => t.id)).toEqual([follow]);
    expect((await tasks.list()).map((t) => t.id)).toEqual([follow, id]);

    for (let i = 1; i <= 5; i++) await tasks.addEvent(id, i % 2 ? "step" : "tool", `événement ${i}`);
    await tasks.addEvent(id, "text", "x".repeat(5000));
    const events = await tasks.events(id);
    expect(events.map((e) => e.text.slice(0, 11))).toEqual(["événement 1", "événement 2", "événement 3", "événement 4", "événement 5", "xxxxxxxxxxx"]);
    expect(events[5]!.text).toHaveLength(4000);
    expect((await tasks.events(id, events[2]!.id)).map((e) => e.text)).toHaveLength(3);
  });

  it("réglages : valeurs par défaut, enregistrement validé, projets", async () => {
    const settings = createSettingsStore(db);
    const defaults = await settings.get();
    expect(defaults.actionMode).toBe("shadow");

    await settings.save({ ...defaults, actionMode: "comment", budget: { monthlyUsd: 12.5 } });
    expect(await settings.get()).toMatchObject({ actionMode: "comment", budget: { monthlyUsd: 12.5 } });
    await expect(settings.save({ ...defaults, actionMode: "n'importe quoi" })).rejects.toThrow();
    expect((await settings.get()).actionMode).toBe("comment");

    const project = { projectId: 5, path: "g/b", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "" };
    await settings.saveProject(project);
    await settings.saveProject({ ...project, projectId: 2, path: "g/a" });
    await settings.saveProject({ ...project, instructions: "mis à jour" }); // même projet : remplacé
    expect((await settings.listProjects()).map((p) => p.path)).toEqual(["g/a", "g/b"]);
    expect((await settings.getProject(5))?.instructions).toBe("mis à jour");
    expect(await settings.getProject(99)).toBeNull();
    await expect(settings.saveProject({ ...project, baseBranch: "" })).rejects.toThrow(/Branche de départ/);
    await settings.deleteProject(5);
    expect(await settings.getProject(5)).toBeNull();
  });

  it("coûts : nombres (jamais du texte), mois courant", async () => {
    const reviews = createReviewRepo(db);
    const id = (await reviews.insertIfNew({ projectId: 1, projectPath: "g/p", mrIid: 1, mrTitle: "t", mrUrl: "u", author: "a", headSha: "c".repeat(40) }))!;
    await reviews.saveResult(id, { status: "auto_ok", decisionReasons: [], resultJson: "{}", changedLines: 1, costUsd: 1.25, numTurns: 1 });
    const costs = createCostRepo(db);
    const lines = await costs.breakdown(currentMonth());
    expect(lines).toEqual([{ kind: "review", projectPath: "g/p", usd: 1.25, count: 1 }]);
    expect(typeof lines[0]!.usd).toBe("number");
    expect(typeof lines[0]!.count).toBe("number");
  });
});
