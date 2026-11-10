import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSettingsStore } from "../settings/store.js";
import { AccountError, createAccountRepo, type Role } from "./accounts.js";
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
  /** Chaque ouverture donne une base neuve et indépendante (pas le serveur réel, dont l'ouverture vide la base partagée). */
  fresh: boolean;
}

const backends: Backend[] = [
  { name: "SQLite", open: async () => openSqlite(":memory:"), fresh: true },
  { name: "PostgreSQL (PGlite)", open: async () => postgresFromPglite(new PGlite() as unknown as PgliteLike), fresh: true },
];

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  backends.push({
    name: "PostgreSQL (serveur réel, pilote pg)",
    fresh: false,
    async open() {
      if (!/test/i.test(new URL(testUrl).pathname)) throw new Error("TEST_DATABASE_URL doit viser une base dont le nom contient « test » : elle est vidée");
      const db = await openPostgres(testUrl);
      await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      return db;
    },
  });
}

const TABLES_IN_DELETE_ORDER = ["actions", "dev_task_events", "dev_tasks", "reviews", "projects", "settings", "memberships", "workspaces", "users"];
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
    expect((await tasks.findActive("gitlab", 1, 609))?.id).toBe(id);
    expect(await tasks.findActive("gitlab", 1, 610)).toBeUndefined();

    await tasks.update(id, { status: "running", branch: "feature/609-x", cost_usd: undefined });
    await tasks.update(id, {});
    await tasks.update(id, { status: "mr_created", mr_iid: 12, mr_url: "https://m/12", cost_usd: 0.5, num_turns: 9, files_changed: 3 });
    const done = (await tasks.get(id))!;
    expect(done).toMatchObject({ status: "mr_created", branch: "feature/609-x", mr_iid: 12, cost_usd: 0.5, num_turns: 9, files_changed: 3 });
    expect(done.updated_at).toMatch(DATE_FORMAT);
    expect(await tasks.findActive("gitlab", 1, 609)).toBeUndefined();

    const follow = await tasks.insert({
      projectId: 1, projectPath: "g/p", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: "Ajoute les docblocks",
      followup: { parentId: id, branch: "feature/609-x", baseBranch: "develop", targetBranch: "develop", mrIid: 12, mrUrl: "https://m/12" },
    });
    expect(await tasks.get(follow)).toMatchObject({ mode: "followup", parent_id: id, branch: "feature/609-x", base_branch: "develop", mr_iid: 12 });
    expect((await tasks.latestByIssue()).get("gitlab#1#609")?.id).toBe(follow);
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
    expect((await settings.getProject("gitlab", 5))?.instructions).toBe("mis à jour");
    expect(await settings.getProject("gitlab", 99)).toBeNull();
    await expect(settings.saveProject({ ...project, baseBranch: "" })).rejects.toThrow(/Branche de départ/);
    await settings.deleteProject("gitlab", 5);
    expect(await settings.getProject("gitlab", 5)).toBeNull();
  });

  it("deux forges, même numéro de projet : tout reste séparé", async () => {
    const settings = createSettingsStore(db);
    const project = { projectId: 5, path: "g/b", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "" };
    await settings.saveProject({ ...project, instructions: "côté GitLab" }); // sans « source » : GitLab, comme avant
    await settings.saveProject({ ...project, source: "github", path: "acme/b", instructions: "côté GitHub" });

    expect((await settings.listProjects()).map((p) => `${p.source}:${p.path}`)).toEqual(["github:acme/b", "gitlab:g/b"]);
    expect((await settings.getProject("gitlab", 5))?.instructions).toBe("côté GitLab");
    expect((await settings.getProject("github", 5))?.instructions).toBe("côté GitHub");
    await settings.saveProject({ ...project, source: "github", path: "acme/b", instructions: "GitHub mis à jour" });
    expect((await settings.getProject("github", 5))?.instructions).toBe("GitHub mis à jour");
    expect((await settings.getProject("gitlab", 5))?.instructions).toBe("côté GitLab");

    await settings.deleteProject("github", 5);
    expect(await settings.getProject("github", 5)).toBeNull();
    expect(await settings.getProject("gitlab", 5)).not.toBeNull();
    await expect(settings.saveProject({ ...project, source: "gitea" })).rejects.toThrow();

    const tasks = createDevTaskRepo(db);
    const base = { projectId: 1, projectPath: "g/p", issueIid: 609, issueTitle: "t", issueUrl: "u", extraInstructions: null };
    const onGitlab = await tasks.insert(base);
    const onGithub = await tasks.insert({ ...base, source: "github", projectPath: "acme/p" });
    expect(await tasks.get(onGitlab)).toMatchObject({ source: "gitlab" });
    expect(await tasks.get(onGithub)).toMatchObject({ source: "github" });
    expect((await tasks.findActive("github", 1, 609))?.id).toBe(onGithub);
    expect((await tasks.findActive("gitlab", 1, 609))?.id).toBe(onGitlab);
    await tasks.update(onGitlab, { status: "mr_created" });
    expect(await tasks.findActive("gitlab", 1, 609)).toBeUndefined();
    expect((await tasks.findActive("github", 1, 609))?.id).toBe(onGithub);
    const latest = await tasks.latestByIssue();
    expect([latest.get("gitlab#1#609")?.id, latest.get("github#1#609")?.id]).toEqual([onGitlab, onGithub]);

    const reviews = createReviewRepo(db);
    const mr = { projectId: 1, projectPath: "g/p", mrIid: 7, mrTitle: "t", mrUrl: "u", author: "a", headSha: "d".repeat(40) };
    const review = (await reviews.insertIfNew(mr))!;
    const reviewOnGithub = (await reviews.insertIfNew({ ...mr, source: "github", headSha: "e".repeat(40) }))!;
    expect((await reviews.get(review))?.source).toBe("gitlab");
    expect((await reviews.get(reviewOnGithub))?.source).toBe("github");
  });

  it("comptes : utilisateurs, adresses uniques, nom et email validés", async () => {
    const accounts = createAccountRepo(db);
    const alice = await accounts.createUser({ name: "  Alice  ", email: " Alice@Example.com " });
    expect(await accounts.getUser(alice)).toMatchObject({ id: alice, name: "Alice", email: "alice@example.com" });
    expect((await accounts.getUserByEmail("ALICE@example.com"))?.id).toBe(alice);
    expect(await accounts.getUserByEmail("personne@example.com")).toBeUndefined();

    await expect(accounts.createUser({ name: "Autre", email: "alice@example.com" })).rejects.toThrow(/déjà utilisée/);
    await expect(accounts.createUser({ name: "   " })).rejects.toThrow(AccountError);
    await expect(accounts.createUser({ name: "x".repeat(101) })).rejects.toThrow(/entre 1 et 100/);
    await expect(accounts.createUser({ name: "Bob", email: "pas-un-email" })).rejects.toThrow(/invalide/);

    // Sans adresse, plusieurs utilisateurs sont permis (l'unicité ne vise que les adresses renseignées)
    const bob = await accounts.createUser({ name: "Bob" });
    const carl = await accounts.createUser({ name: "Carl", email: "" });
    expect(await accounts.getUser(bob)).toMatchObject({ email: null });
    expect(await accounts.getUser(carl)).toMatchObject({ email: null });
    expect(await accounts.getUser(999_999)).toBeUndefined();
  });

  it("comptes : espace personnel (un seul membre), espace d'équipe, étanchéité de l'appartenance", async () => {
    const accounts = createAccountRepo(db);
    const alice = await accounts.createUser({ name: "Alice" });
    const bob = await accounts.createUser({ name: "Bob" });

    const home = await accounts.createWorkspace({ name: "  Chez Alice ", kind: "personal", adminUserId: alice });
    expect(await accounts.getWorkspace(home)).toMatchObject({ name: "Chez Alice", kind: "personal" });
    expect(await accounts.membershipRole(home, alice)).toBe("admin");
    expect(await accounts.membershipRole(home, bob)).toBeNull(); // pas membre : aucun rôle

    await expect(accounts.createWorkspace({ name: "Deuxième", kind: "personal", adminUserId: alice })).rejects.toThrow(/déjà un espace personnel/);
    await expect(accounts.addMember(home, bob, "member")).rejects.toThrow(/espace personnel/);
    await expect(accounts.setRole(home, alice, "member")).rejects.toThrow(/espace personnel/);
    await expect(accounts.removeMember(home, alice)).rejects.toThrow(/espace personnel/);
    expect(await accounts.membershipRole(home, alice)).toBe("admin");

    const team = await accounts.createWorkspace({ name: "Équipe", kind: "team", adminUserId: alice });
    await accounts.addMember(team, bob, "member");
    expect(await accounts.membershipRole(team, bob)).toBe("member");
    expect(await accounts.membershipRole(home, bob)).toBeNull(); // l'équipe ne donne rien sur l'espace personnel d'Alice

    expect((await accounts.listMembers(team)).map((m) => `${m.name}:${m.role}`)).toEqual(["Alice:admin", "Bob:member"]);
    expect((await accounts.listWorkspacesOf(alice)).map((w) => `${w.name}:${w.kind}:${w.role}`)).toEqual(["Chez Alice:personal:admin", "Équipe:team:admin"]);
    expect((await accounts.listWorkspacesOf(bob)).map((w) => `${w.name}:${w.role}`)).toEqual(["Équipe:member"]);

    await accounts.renameWorkspace(team, " Équipe BO ");
    expect((await accounts.getWorkspace(team))?.name).toBe("Équipe BO");
    await expect(accounts.renameWorkspace(team, " ")).rejects.toThrow(AccountError);
    await expect(accounts.renameWorkspace(999_999, "x")).rejects.toThrow(/Espace introuvable/);
  });

  it("comptes : ajout de membre refusé hors règles, aucune trace d'un espace refusé", async () => {
    const accounts = createAccountRepo(db);
    const alice = await accounts.createUser({ name: "Alice" });
    const bob = await accounts.createUser({ name: "Bob" });
    const team = await accounts.createWorkspace({ name: "Équipe", kind: "team", adminUserId: alice });

    await accounts.addMember(team, bob, "viewer");
    await expect(accounts.addMember(team, bob, "admin")).rejects.toThrow(/déjà membre/);
    expect(await accounts.membershipRole(team, bob)).toBe("viewer"); // le doublon ne change pas le rôle
    await expect(accounts.addMember(team, 999_999, "member")).rejects.toThrow(/Utilisateur introuvable/);
    await expect(accounts.addMember(999_999, bob, "member")).rejects.toThrow(/Espace introuvable/);
    await expect(accounts.addMember(team, bob, "root" as Role)).rejects.toThrow(/Rôle inconnu/);
    await expect(accounts.setRole(team, bob, "root" as Role)).rejects.toThrow(/Rôle inconnu/);

    const before = await db.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM workspaces");
    await expect(accounts.createWorkspace({ name: "Fantôme", kind: "team", adminUserId: 999_999 })).rejects.toThrow(/Utilisateur introuvable/);
    await expect(accounts.createWorkspace({ name: "Fantôme", kind: "autre" as "team", adminUserId: alice })).rejects.toThrow(/Type d'espace/);
    expect(await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM workspaces")).toEqual(before);

    // La base refuse aussi, indépendamment du code
    await expect(db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'root')", [team, alice])).rejects.toThrow();
    await expect(db.run("INSERT INTO workspaces (name, kind) VALUES ('x', 'autre')")).rejects.toThrow();
    await expect(db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (999999, ?, 'member')", [alice])).rejects.toThrow();
  });

  it("comptes : un espace garde toujours un administrateur", async () => {
    const accounts = createAccountRepo(db);
    const alice = await accounts.createUser({ name: "Alice" });
    const bob = await accounts.createUser({ name: "Bob" });
    const team = await accounts.createWorkspace({ name: "Équipe", kind: "team", adminUserId: alice });
    await accounts.addMember(team, bob, "member");

    // Alice est la seule admin : ni rétrogradée, ni retirée
    await expect(accounts.setRole(team, alice, "member")).rejects.toThrow(/dernier administrateur/);
    await expect(accounts.removeMember(team, alice)).rejects.toThrow(/dernier administrateur/);
    await accounts.setRole(team, alice, "admin"); // rester admin n'est pas une rétrogradation
    expect(await accounts.membershipRole(team, alice)).toBe("admin");

    // Avec un second admin, Alice peut passer viewer, puis Bob devient le dernier
    await accounts.setRole(team, bob, "admin");
    await accounts.setRole(team, alice, "viewer");
    expect(await accounts.membershipRole(team, alice)).toBe("viewer");
    await expect(accounts.setRole(team, bob, "member")).rejects.toThrow(/dernier administrateur/);
    await expect(accounts.removeMember(team, bob)).rejects.toThrow(/dernier administrateur/);

    // Un non-admin peut partir librement ; un absent ne peut ni partir ni changer de rôle
    await accounts.removeMember(team, alice);
    expect(await accounts.membershipRole(team, alice)).toBeNull();
    await expect(accounts.removeMember(team, alice)).rejects.toThrow(/n'est pas membre/);
    await expect(accounts.setRole(team, alice, "admin")).rejects.toThrow(/n'est pas membre/);
    expect((await accounts.listMembers(team)).map((m) => m.name)).toEqual(["Bob"]);
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

describe.each(backends.filter((b) => b.fresh))("migration « plusieurs forges » : $name", ({ open }) => {
  it("les données d'un outil à la version 3 sont conservées et deviennent des données GitLab", async () => {
    const db = await open();
    try {
      const all = migrationsFor(db.sql);
      expect(all.length).toBeGreaterThanOrEqual(5); // la migration « plusieurs forges » est la 4e ; les suivantes s'appliquent à la suite
      await db.schemaVersion(); // comme `migrate` : sur PostgreSQL, crée la table de suivi des versions
      for (const [i, sql] of all.slice(0, 3).entries()) {
        await db.transaction(async (tx) => {
          await tx.exec(sql);
          await tx.setSchemaVersion(i + 1);
        });
      }
      const config = { projectId: 29, path: "g/bo", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "FuelPHP" };
      await db.run("INSERT INTO reviews (project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha) VALUES (29, 'g/bo', 716, 't', 'u', 'a', ?)", ["a".repeat(40)]);
      await db.run("INSERT INTO dev_tasks (project_id, project_path, issue_iid, issue_title, issue_url) VALUES (29, 'g/bo', 609, 't', 'u')");
      await db.run("INSERT INTO projects (project_id, path, config) VALUES (29, 'g/bo', ?)", [JSON.stringify(config)]);
      expect(await db.schemaVersion()).toBe(3);

      await migrate(db);

      expect(await db.schemaVersion()).toBe(all.length);
      expect(await db.get("SELECT source, project_id, mr_iid FROM reviews")).toEqual({ source: "gitlab", project_id: 29, mr_iid: 716 });
      expect(await db.get("SELECT source, project_id, issue_iid FROM dev_tasks")).toEqual({ source: "gitlab", project_id: 29, issue_iid: 609 });
      expect(await db.get("SELECT source, project_id, path FROM projects")).toEqual({ source: "gitlab", project_id: 29, path: "g/bo" });
      expect(await createSettingsStore(db).getProject("gitlab", 29)).toMatchObject({ source: "gitlab", path: "g/bo", devEnabled: true, instructions: "FuelPHP" });
      expect(await createSettingsStore(db).getProject("github", 29)).toBeNull();

      // La clé des projets inclut maintenant la forge : le même numéro chez GitHub est un autre projet
      await createSettingsStore(db).saveProject({ ...config, source: "github", path: "acme/bo" });
      expect((await createSettingsStore(db).listProjects()).map((p) => `${p.source}:${p.path}`)).toEqual(["github:acme/bo", "gitlab:g/bo"]);
    } finally {
      await db.close();
    }
  });
});

describe.each(backends.filter((b) => b.fresh))("migration « comptes et espaces » : $name", ({ open }) => {
  it("un outil à la version 4 garde ses données et reçoit un utilisateur local, administrateur de son espace personnel", async () => {
    const db = await open();
    try {
      await db.schemaVersion(); // comme `migrate` : sur PostgreSQL, crée la table de suivi des versions
      for (const [i, sql] of migrationsFor(db.sql).slice(0, 4).entries()) {
        await db.transaction(async (tx) => {
          await tx.exec(sql);
          await tx.setSchemaVersion(i + 1);
        });
      }
      await db.run("INSERT INTO reviews (project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha) VALUES (29, 'g/bo', 716, 't', 'u', 'a', ?)", ["a".repeat(40)]);
      await db.run("INSERT INTO settings (key, value) VALUES ('actionMode', '\"comment\"')");
      expect(await db.schemaVersion()).toBe(4);

      await migrate(db);

      expect(await db.schemaVersion()).toBe(migrationsFor(db.sql).length);
      expect(await db.get("SELECT source, project_id, mr_iid FROM reviews")).toEqual({ source: "gitlab", project_id: 29, mr_iid: 716 });
      expect(await db.get("SELECT value FROM settings WHERE key = 'actionMode'")).toEqual({ value: '"comment"' });

      const accounts = createAccountRepo(db);
      const local = await accounts.localContext();
      expect(local.role).toBe("admin");
      expect(await accounts.getUser(local.userId)).toMatchObject({ name: "Utilisateur local", email: null });
      expect(await accounts.getWorkspace(local.workspaceId)).toMatchObject({ name: "Espace local", kind: "personal" });
      expect((await accounts.listWorkspacesOf(local.userId)).map((w) => w.id)).toEqual([local.workspaceId]);
      expect(await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users")).toEqual({ n: 1 });

      await migrate(db); // relancée : pas de second utilisateur local
      expect(await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users")).toEqual({ n: 1 });
      expect(await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM memberships")).toEqual({ n: 1 });

      // Les identifiants suivants continuent après l'utilisateur local (pas de collision sur PostgreSQL)
      const next = await accounts.createUser({ name: "Alice" });
      expect(next).toBeGreaterThan(local.userId);
    } finally {
      await db.close();
    }
  });
});
