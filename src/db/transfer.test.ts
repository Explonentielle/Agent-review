import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keyring } from "../secrets/crypto.js";
import { createSecretStore } from "../secrets/store.js";
import { createSettingsStore } from "../settings/store.js";
import { createAccountRepo } from "./accounts.js";
import { createAuditRepo } from "./audit.js";
import type { Db } from "./db.js";
import { createDevTaskRepo } from "./devTasks.js";
import { migrate } from "./migrations.js";
import { postgresFromPglite, type PgliteLike } from "./postgres.js";
import { createReviewRepo } from "./reviews.js";
import { openSqlite } from "./sqlite.js";
import { TRANSFER_TABLES, copyDatabase } from "./transfer.js";

const MR = { projectId: 29, projectPath: "g/bo", mrIid: 716, mrTitle: "t", mrUrl: "u", author: "a", headSha: "a".repeat(40) };

describe("copie d'une base vers une autre (SQLite local vers PostgreSQL du serveur)", () => {
  let source: Db;
  let target: Db;
  let keyring: Keyring;
  let ws: number;
  let user: number;

  beforeEach(async () => {
    source = openSqlite(":memory:");
    await migrate(source);
    target = postgresFromPglite(new PGlite() as unknown as PgliteLike);
    await migrate(target);
    keyring = new Keyring([randomBytes(32)]);

    // Une installation locale bien remplie : le compte local, deux espaces, des reviews, des tâches reprises, des secrets, un audit
    const accounts = createAccountRepo(source);
    const local = await accounts.localContext();
    ws = local.workspaceId;
    user = local.userId;
    await accounts.renameUser(user, "Alex");
    await accounts.linkIdentity(user, "gitlab", "42", "alex");
    const bob = await accounts.createUser({ name: "Bob", email: "bob@example.com" });
    const team = await accounts.createWorkspace({ name: "Équipe", kind: "team", adminUserId: user });
    await accounts.addMember(team, bob, "member");

    const reviews = createReviewRepo(source, ws);
    const review = (await reviews.insertIfNew(MR))!;
    await reviews.saveResult(review, { status: "needs_human", decisionReasons: ["x"], resultJson: "{}", changedLines: 12, costUsd: 0.0222, numTurns: 4 });
    await reviews.logAction(review, "comment", true, "détail");
    await createReviewRepo(source, team).insertIfNew(MR);

    const tasks = createDevTaskRepo(source, ws);
    const parent = await tasks.insert({ projectId: 29, projectPath: "g/bo", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null });
    await tasks.update(parent, { status: "mr_created", branch: "feature/609-x", worktree_path: "/home/alex/dossier-local", session_id: "session-locale", mr_iid: 12 });
    await tasks.insert({ projectId: 29, projectPath: "g/bo", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: "reprise", followup: { parentId: parent, branch: "feature/609-x", baseBranch: "develop", targetBranch: "develop", mrIid: 12, mrUrl: "m" } });
    await tasks.addEvent(parent, "step", "événement avec accents : été");

    const settings = createSettingsStore(source, ws);
    await settings.save({ ...(await settings.get()), reviewTrigger: "manual", budget: { monthlyUsd: 12.5 } });
    await settings.saveProject({ projectId: 29, path: "g/bo", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "FuelPHP" });

    await createSecretStore(source, keyring).put({ workspaceId: ws, userId: user }, "github.token", "github_pat_A_COPIER_1234");
    await createAuditRepo(source, ws, user).record({ source: "gitlab", action: "ticket_labels", target: "29/609", detail: { labels: ["x"] } });
    await source.run("INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at) VALUES ('h', ?, ?, '2999-01-01 00:00:00')", [user, ws]);
  });
  afterEach(async () => {
    await source.close();
    await target.close();
  });

  /** Contenu d'une table, trié, pour comparer la source et la cible. */
  const dump = (db: Db, table: string) => db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1, 2`);

  it("toutes les données arrivent, identifiants compris, et les compteurs repartent après le plus grand", async () => {
    const { copied } = await copyDatabase(source, target);

    for (const table of TRANSFER_TABLES) {
      const expected = await dump(source, table);
      expect(copied[table]).toBe(expected.length);
      const actual = await dump(target, table);
      // Les dossiers de travail locaux sont vidés : on compare tout le reste
      const strip = (rows: Record<string, unknown>[]) => rows.map(({ worktree_path: _w, session_id: _s, ...rest }) => rest);
      expect(strip(actual)).toEqual(strip(expected));
    }
    expect(await target.get("SELECT name FROM users WHERE id = ?", [user])).toEqual({ name: "Alex" });
    expect(await target.get("SELECT COUNT(*) AS n FROM sessions")).toMatchObject({ n: expect.anything() });
    expect(Number((await target.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions"))!.n)).toBe(0); // les sessions ne suivent pas

    // Les chemins propres à l'ancienne machine sont vidés, le reste de la tâche est intact
    expect(await target.get("SELECT status, branch, worktree_path, session_id, mr_iid FROM dev_tasks WHERE parent_id IS NULL")).toEqual({ status: "mr_created", branch: "feature/609-x", worktree_path: null, session_id: null, mr_iid: 12 });

    // Le prochain ajout ne rentre pas en collision avec un identifiant copié
    const reviews = createReviewRepo(target, ws);
    const next = (await reviews.insertIfNew({ ...MR, mrIid: 717 }))!;
    const maxCopied = Math.max(...(await dump(source, "reviews")).map((r) => Number(r.id)));
    expect(next).toBeGreaterThan(maxCopied);
    expect(await createAccountRepo(target).createUser({ name: "Nouveau" })).toBeGreaterThan(Math.max(...(await dump(source, "users")).map((r) => Number(r.id))));
  });

  it("les données copiées fonctionnent comme sur la source : réglages, projets, appartenances, secrets avec la même clé", async () => {
    await copyDatabase(source, target);

    const settings = createSettingsStore(target, ws);
    expect(await settings.get()).toMatchObject({ reviewTrigger: "manual", budget: { monthlyUsd: 12.5 } });
    expect((await settings.getProject("gitlab", 29))?.instructions).toBe("FuelPHP");
    expect((await createAccountRepo(target).localContext()).userId).toBe(user);
    expect((await createAccountRepo(target).listWorkspacesOf(user)).map((w) => w.name).sort()).toEqual(["Espace local", "Équipe"]);
    expect((await createAccountRepo(target).findUserByIdentity("gitlab", "42"))?.id).toBe(user);

    const store = createSecretStore(target, keyring);
    expect(await store.get({ workspaceId: ws, userId: user }, "github.token")).toBe("github_pat_A_COPIER_1234");
    await expect(createSecretStore(target, new Keyring([randomBytes(32)])).get({ workspaceId: ws, userId: user }, "github.token")).rejects.toThrow(/illisible/); // autre clé : illisible
    expect((await createAuditRepo(target, ws, user).list())[0]).toMatchObject({ action: "ticket_labels" });
  });

  it("une cible qui contient déjà des données est refusée, sans rien copier ni effacer", async () => {
    const existing = createReviewRepo(target, (await createAccountRepo(target).localContext()).workspaceId);
    await existing.insertIfNew(MR);

    await expect(copyDatabase(source, target)).rejects.toThrow(/n'est pas vide \(reviews\)/);
    expect((await existing.list()).length).toBe(1);
    expect(Number((await target.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n)).toBe(1);
  });

  it("une base d'une autre version du schéma est refusée", async () => {
    const old = openSqlite(":memory:");
    try {
      await old.exec("PRAGMA user_version = 3");
      await expect(copyDatabase(old, target)).rejects.toThrow(/version 3 du schéma/);
    } finally {
      await old.close();
    }
  });

  it("une erreur au milieu de la copie laisse la cible intacte", async () => {
    // Une ligne que la cible refuse (rôle inconnu, contourne la source en le forçant) fait échouer la copie
    await source.exec("PRAGMA ignore_check_constraints = ON");
    await source.run("UPDATE memberships SET role = 'root' WHERE rowid = (SELECT MIN(rowid) FROM memberships)");

    await expect(copyDatabase(source, target)).rejects.toThrow();
    expect(await target.get("SELECT name FROM users")).toEqual({ name: "Utilisateur local" }); // le compte local d'origine est toujours là
    expect(Number((await target.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships"))!.n)).toBe(1);
  });
});
