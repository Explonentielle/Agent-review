import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keyring } from "../secrets/crypto.js";
import { createSecretStore } from "../secrets/store.js";
import { createSettingsStore } from "../settings/store.js";
import { PROJECT_ROOT } from "../paths.js";
import { createAccountRepo } from "./accounts.js";
import { createAuditRepo } from "./audit.js";
import { createCostRepo, currentMonth } from "./costs.js";
import type { Db } from "./db.js";
import { createDevTaskRepo } from "./devTasks.js";
import { migrate } from "./migrations.js";
import { postgresFromPglite, type PgliteLike } from "./postgres.js";
import { createReviewRepo } from "./reviews.js";
import { openSqlite } from "./sqlite.js";

/**
 * Tests d'étanchéité (roadmap-plateforme, C4) : deux espaces partagent la même base, aucune opération d'un espace
 * ne lit, ne modifie, ne supprime ni ne compte les données de l'autre. Chaque test est joué sur les deux moteurs.
 */
const backends: { name: string; open: () => Promise<Db> }[] = [
  { name: "SQLite", open: async () => openSqlite(":memory:") },
  { name: "PostgreSQL (PGlite)", open: async () => postgresFromPglite(new PGlite() as unknown as PgliteLike) },
];

const SHA = "a".repeat(40);
const MR = { projectId: 1, projectPath: "g/p", mrIid: 7, mrTitle: "t", mrUrl: "u", author: "a", headSha: SHA };
const ISSUE = { projectId: 1, projectPath: "g/p", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null };
const PROJECT = { projectId: 5, path: "g/b", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "" };

describe.each(backends)("étanchéité entre espaces : $name", ({ open }) => {
  let db: Db;
  let a: number;
  let b: number;

  beforeAll(async () => {
    db = await open();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    for (const table of ["actions", "dev_task_events", "dev_tasks", "reviews", "projects", "settings", "secrets", "audit_log", "invitations", "email_tokens", "credentials", "memberships", "workspaces", "users"]) await db.run(`DELETE FROM ${table}`);
    const accounts = createAccountRepo(db);
    const alice = await accounts.createUser({ name: "Alice" });
    const bob = await accounts.createUser({ name: "Bob" });
    a = await accounts.createWorkspace({ name: "Espace A", kind: "team", adminUserId: alice });
    b = await accounts.createWorkspace({ name: "Espace B", kind: "team", adminUserId: bob });
  });

  it("reviews : même demande de fusion dans deux espaces, aucune lecture ni modification croisée", async () => {
    const ra = createReviewRepo(db, a);
    const rb = createReviewRepo(db, b);

    const idA = (await ra.insertIfNew(MR))!;
    expect(await ra.insertIfNew(MR)).toBeNull(); // doublon dans le même espace
    const idB = (await rb.insertIfNew(MR))!; // le même commit dans l'autre espace est une autre review
    expect(idB).not.toBe(idA);
    expect(await ra.get(idA)).toMatchObject({ workspace_id: a });
    expect(await rb.get(idB)).toMatchObject({ workspace_id: b });

    // Lecture : l'autre espace ne voit rien
    const onlyA = (await ra.insertIfNew({ ...MR, mrIid: 8 }))!;
    expect(await rb.get(onlyA)).toBeUndefined();
    expect((await rb.list()).map((r) => r.id)).toEqual([idB]);
    expect((await rb.list("queued")).map((r) => r.id)).toEqual([idB]);
    expect((await rb.listInterrupted()).map((r) => r.id)).toEqual([idB]);
    expect(await rb.countByStatus()).toEqual({ queued: 1 });

    // Écriture : rien ne passe chez l'autre
    await rb.setStatus(onlyA, "dismissed");
    await rb.saveError(onlyA, "pirate");
    await rb.saveResult(onlyA, { status: "auto_ok", decisionReasons: [], resultJson: "{}", changedLines: 1, costUsd: 9, numTurns: 1 });
    await rb.saveFeedback(onlyA, true, "pirate");
    expect(await ra.get(onlyA)).toMatchObject({ status: "queued", error: null, cost_usd: null, feedback_agree: null, feedback_note: null });

    // Journal d'actions : refusé, rien d'écrit
    await expect(rb.logAction(onlyA, "approve", false)).rejects.toThrow(/introuvable dans cet espace/);
    expect(await db.get("SELECT COUNT(*) AS n FROM actions")).toMatchObject({ n: expect.anything() });
    expect(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM actions"))!.n)).toBe(0);
    await ra.logAction(onlyA, "comment", true, "détail");
    expect(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM actions"))!.n)).toBe(1);

    // Statistiques par espace
    await ra.saveFeedback(idA, true, null);
    await rb.saveFeedback(idB, false, null);
    expect(await ra.agreementStats()).toEqual({ rated: 1, agreed: 1 });
    expect(await rb.agreementStats()).toEqual({ rated: 1, agreed: 0 });
  });

  it("tâches de dev : lecture, modification, journal et reprise limités à l'espace", async () => {
    const ta = createDevTaskRepo(db, a);
    const tb = createDevTaskRepo(db, b);

    const idA = await ta.insert(ISSUE);
    const idB = await tb.insert(ISSUE); // même ticket, autre espace : deux agents possibles
    expect(await ta.findActive("gitlab", 1, 609)).toMatchObject({ id: idA, workspace_id: a });
    expect(await tb.findActive("gitlab", 1, 609)).toMatchObject({ id: idB, workspace_id: b });

    const onlyA = await ta.insert({ ...ISSUE, issueIid: 610 });
    expect(await tb.get(onlyA)).toBeUndefined();
    expect(await tb.findActive("gitlab", 1, 610)).toBeUndefined();
    expect((await tb.list()).map((t) => t.id)).toEqual([idB]);
    expect((await tb.listInterrupted()).map((t) => t.id)).toEqual([idB]);
    expect([...(await tb.latestByIssue()).values()].map((t) => t.id)).toEqual([idB]);
    expect([...(await ta.latestByIssue()).keys()].sort()).toEqual(["gitlab#1#609", "gitlab#1#610"]);

    await tb.update(onlyA, { status: "error", error: "pirate", branch: "pirate" });
    expect(await ta.get(onlyA)).toMatchObject({ status: "queued", error: null, branch: null });

    // Journal : écriture refusée, lecture vide
    await ta.addEvent(onlyA, "step", "événement d'A");
    await expect(tb.addEvent(onlyA, "step", "pirate")).rejects.toThrow(/introuvable dans cet espace/);
    expect((await ta.events(onlyA)).map((e) => e.text)).toEqual(["événement d'A"]);
    expect(await tb.events(onlyA)).toEqual([]);

    // Une reprise ne peut pas s'accrocher à la tâche d'un autre espace
    const followup = { parentId: onlyA, branch: "feature/610", baseBranch: "develop", targetBranch: "develop", mrIid: 1, mrUrl: "u" };
    await expect(tb.insert({ ...ISSUE, issueIid: 610, followup })).rejects.toThrow(/introuvable dans cet espace/);
    expect(await ta.insert({ ...ISSUE, issueIid: 610, followup })).toBeGreaterThan(onlyA);
  });

  it("réglages et projets : séparés par espace, même clé de projet possible partout", async () => {
    const sa = createSettingsStore(db, a);
    const sb = createSettingsStore(db, b);

    const defaults = await sa.get();
    await sa.save({ ...defaults, actionMode: "comment", budget: { monthlyUsd: 40 } });
    expect(await sa.get()).toMatchObject({ actionMode: "comment", budget: { monthlyUsd: 40 } });
    expect(await sb.get()).toMatchObject({ actionMode: defaults.actionMode, budget: defaults.budget }); // B garde les valeurs par défaut
    await sb.save({ ...defaults, actionMode: "auto" });
    expect((await sa.get()).actionMode).toBe("comment"); // l'enregistrement de B n'écrase pas A

    await sa.saveProject({ ...PROJECT, instructions: "chez A" });
    expect(await sb.listProjects()).toEqual([]);
    expect(await sb.getProject("gitlab", 5)).toBeNull();
    await sb.saveProject({ ...PROJECT, instructions: "chez B" });
    expect((await sa.getProject("gitlab", 5))?.instructions).toBe("chez A");
    expect((await sb.getProject("gitlab", 5))?.instructions).toBe("chez B");
    await sb.deleteProject("gitlab", 5);
    expect(await sb.getProject("gitlab", 5)).toBeNull();
    expect((await sa.getProject("gitlab", 5))?.instructions).toBe("chez A"); // la suppression de B ne touche pas A
  });

  it("coûts : le total d'un espace n'inclut jamais l'autre", async () => {
    const ra = createReviewRepo(db, a);
    const rb = createReviewRepo(db, b);
    const ta = createDevTaskRepo(db, a);
    const result = (costUsd: number) => ({ status: "auto_ok" as const, decisionReasons: [], resultJson: "{}", changedLines: 1, costUsd, numTurns: 1 });
    await ra.saveResult((await ra.insertIfNew(MR))!, result(1.5));
    await rb.saveResult((await rb.insertIfNew(MR))!, result(10));
    const task = await ta.insert(ISSUE);
    await ta.update(task, { cost_usd: 2 });

    const month = currentMonth();
    expect(await createCostRepo(db, a).monthTotal(month)).toBeCloseTo(3.5);
    expect(await createCostRepo(db, b).monthTotal(month)).toBeCloseTo(10);
    expect((await createCostRepo(db, b).breakdown(month)).map((l) => l.kind)).toEqual(["review"]);
    expect(await createCostRepo(db, (await createAccountRepo(db).createWorkspace({ name: "Vide", kind: "team", adminUserId: (await createAccountRepo(db).createUser({ name: "Zoé" })) })) ).monthTotal(month)).toBe(0);
  });

  it("journal d'audit : chaque espace ne lit que ses lignes, pagination comprise", async () => {
    const auditA = createAuditRepo(db, a, null);
    const auditB = createAuditRepo(db, b, null);
    await auditA.record({ source: "gitlab", action: "ticket_labels", target: "1/1" });
    await auditB.record({ source: "gitlab", action: "change_request_approve", target: "2/2", error: "403" });
    await auditA.record({ source: "github", action: "push_branch", target: "feature/1" });

    expect((await auditA.list()).map((e) => e.action)).toEqual(["push_branch", "ticket_labels"]);
    expect((await auditB.list()).map((e) => [e.action, e.outcome])).toEqual([["change_request_approve", "error"]]);
    const newestOfB = (await auditB.list())[0]!.id;
    expect(await auditA.list(10, newestOfB + 100)).toHaveLength(2); // la pagination ne fait pas sortir de l'espace
    expect((await auditB.list(10, newestOfB + 100)).map((e) => e.action)).toEqual(["change_request_approve"]);
  });

  it("secrets : un secret d'un espace n'est lisible ni listé depuis l'autre", async () => {
    const store = createSecretStore(db, new Keyring([randomBytes(32)]));
    await store.put({ workspaceId: a, userId: null }, "github.token", "secret-de-l-espace-a-1");
    await store.put({ workspaceId: b, userId: null }, "github.token", "secret-de-l-espace-b-1");
    expect(await store.get({ workspaceId: a, userId: null }, "github.token")).toBe("secret-de-l-espace-a-1");
    expect(await store.get({ workspaceId: b, userId: null }, "github.token")).toBe("secret-de-l-espace-b-1");
    expect(await store.delete({ workspaceId: b, userId: null }, "github.token")).toBe(true);
    expect(await store.get({ workspaceId: a, userId: null }, "github.token")).toBe("secret-de-l-espace-a-1");
  });

  it("la base refuse une donnée sans espace ou rattachée à un espace inexistant", async () => {
    await expect(db.run("INSERT INTO reviews (project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha) VALUES (1, 'g', 1, 't', 'u', 'a', 'x')")).rejects.toThrow();
    await expect(db.run("INSERT INTO reviews (workspace_id, project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha) VALUES (999999, 1, 'g', 1, 't', 'u', 'a', 'x')")).rejects.toThrow();
    await expect(db.run("INSERT INTO dev_tasks (project_id, project_path, issue_iid, issue_title, issue_url) VALUES (1, 'g', 1, 't', 'u')")).rejects.toThrow();
    await expect(db.run("INSERT INTO projects (source, project_id, path, config) VALUES ('gitlab', 1, 'g', '{}')")).rejects.toThrow();
    await expect(db.run("INSERT INTO settings (key, value) VALUES ('k', 'v')")).rejects.toThrow();
  });
});

describe("audit : toute requête sur une table d'un espace nomme workspace_id", () => {
  const SCOPED_TABLES = ["reviews", "dev_tasks", "projects", "settings", "secrets", "actions", "dev_task_events", "audit_log"];
  const FILES = ["src/db/reviews.ts", "src/db/devTasks.ts", "src/db/costs.ts", "src/db/audit.ts", "src/settings/store.ts", "src/secrets/store.ts"];
  const SQL_ON_SCOPED = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+(${SCOPED_TABLES.join("|")})\\b`, "i");

  /** Chaînes entre guillemets ou apostrophes inverses d'un fichier source. */
  const literals = (source: string): string[] => source.match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g) ?? [];

  /**
   * Requêtes volontairement globales du coffre à secrets, qui servent la maintenance de la clé maître et ne livrent aucune donnée :
   * savoir s'il existe un secret (avant de choisir la clé), et rechiffrer une ligne dont l'identifiant vient de la lecture globale de `reencryptAll`.
   */
  const GLOBAL_MAINTENANCE = ['"SELECT 1 AS found FROM secrets LIMIT 1"', '"UPDATE secrets SET value = ? WHERE id = ?"'];

  it.each(FILES)("%s : aucune requête sans rattachement à l'espace", (file) => {
    const queries = literals(readFileSync(path.join(PROJECT_ROOT, file), "utf8")).filter((text) => SQL_ON_SCOPED.test(text));
    expect(queries.length).toBeGreaterThan(0); // le contrôle lit bien du SQL
    // Une requête est rattachée si elle nomme workspace_id, ou si elle reçoit la condition construite par `whereOf` (qui le nomme)
    const unscoped = queries.filter((text) => !/workspace_id|\$\{where\.sql\}/.test(text) && !GLOBAL_MAINTENANCE.includes(text));
    expect(unscoped.map((q) => q.replace(/\s+/g, " ").slice(0, 120))).toEqual([]);
  });

  it("la condition `whereOf` du coffre nomme bien l'espace", () => {
    const source = readFileSync(path.join(PROJECT_ROOT, "src/secrets/store.ts"), "utf8");
    expect(source.match(/sql: "workspace_id = \? AND name = \?/g)).toHaveLength(2); // secret partagé et secret personnel
  });

  it("aucun accès direct à ces tables en dehors des dépôts de données", () => {
    const stray = [
      "src/server/app.ts", "src/index.ts", "src/review/pipeline.ts", "src/dev/pipeline.ts", "src/dev/journal.ts", "src/triggers/reviewPoller.ts", "src/budget.ts", "src/cli/reviewOnce.ts",
    ].filter((file) => literals(readFileSync(path.join(PROJECT_ROOT, file), "utf8")).some((text) => SQL_ON_SCOPED.test(text)));
    expect(stray).toEqual([]);
  });
});
