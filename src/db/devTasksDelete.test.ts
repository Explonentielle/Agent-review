import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccountRepo } from "./accounts.js";
import type { Db } from "./db.js";
import { createDevTaskRepo } from "./devTasks.js";
import { migrate } from "./migrations.js";
import { postgresFromPglite, type PgliteLike } from "./postgres.js";
import { openSqlite } from "./sqlite.js";

const backends: { name: string; open: () => Promise<Db> }[] = [
  { name: "SQLite", open: async () => openSqlite(":memory:") },
  { name: "PostgreSQL (PGlite)", open: async () => postgresFromPglite(new PGlite() as unknown as PgliteLike) },
];

const ISSUE = { projectId: 1, projectPath: "g/p", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null };

describe.each(backends)("suppression et historique des tâches de dev : $name", ({ open }) => {
  let db: Db;
  let a: number;
  let b: number;

  beforeEach(async () => {
    db = await open();
    await migrate(db);
    const accounts = createAccountRepo(db);
    const alice = await accounts.createUser({ name: "Alice" });
    const bob = await accounts.createUser({ name: "Bob" });
    a = await accounts.createWorkspace({ name: "Espace A", kind: "team", adminUserId: alice });
    b = await accounts.createWorkspace({ name: "Espace B", kind: "team", adminUserId: bob });
  });
  afterEach(async () => {
    await db.close();
  });

  it("supprime une tâche terminée avec son journal, et seulement elle", async () => {
    const t = createDevTaskRepo(db, a);
    const failed = await t.insert(ISSUE);
    await t.update(failed, { status: "error", error: "MR refusée", branch: "feature/609-x" });
    await t.addEvent(failed, "step", "Branche poussée");
    const other = await t.insert({ ...ISSUE, issueIid: 610 });
    await t.update(other, { status: "mr_created" });
    await t.addEvent(other, "step", "MR créée");

    expect(await t.delete(failed)).toBe("deleted");
    expect(await t.get(failed)).toBeUndefined();
    expect(await t.events(failed)).toEqual([]);
    expect((await t.get(other))?.status).toBe("mr_created"); // l'autre tâche et son journal sont intacts
    expect((await t.events(other)).map((e) => e.text)).toEqual(["MR créée"]);
    expect(await t.delete(failed)).toBe("missing"); // déjà supprimée
  });

  it("refuse de supprimer une tâche en attente ou en cours : l'agent doit d'abord être arrêté", async () => {
    const t = createDevTaskRepo(db, a);
    const queued = await t.insert(ISSUE);
    expect(await t.delete(queued)).toBe("active");
    await t.update(queued, { status: "running" });
    expect(await t.delete(queued)).toBe("active");
    expect(await t.get(queued)).toBeDefined();
    await t.update(queued, { status: "cancelled" });
    expect(await t.delete(queued)).toBe("deleted");
  });

  it("une reprise garde son rapport quand sa tâche d'origine est supprimée (elle perd seulement son parent)", async () => {
    const t = createDevTaskRepo(db, a);
    const parent = await t.insert(ISSUE);
    await t.update(parent, { status: "mr_created", branch: "feature/609-x", mr_iid: 3, mr_url: "u" });
    const child = await t.insert({ ...ISSUE, followup: { parentId: parent, branch: "feature/609-x", baseBranch: "develop", targetBranch: "develop", mrIid: 3, mrUrl: "u" } });
    await t.update(child, { status: "mr_updated" });

    expect(await t.delete(parent)).toBe("deleted");
    expect(await t.get(child)).toMatchObject({ status: "mr_updated", parent_id: null });
  });

  it("étanche : l'autre espace ne peut ni supprimer ni voir cette tâche", async () => {
    const ta = createDevTaskRepo(db, a);
    const tb = createDevTaskRepo(db, b);
    const mine = await ta.insert(ISSUE);
    await ta.update(mine, { status: "error" });
    await ta.addEvent(mine, "step", "journal d'A");

    expect(await tb.delete(mine)).toBe("missing");
    expect(await ta.get(mine)).toMatchObject({ status: "error" });
    expect((await ta.events(mine)).map((e) => e.text)).toEqual(["journal d'A"]);
  });

  it("retrouve la tâche qui a ouvert une MR : la plus récente, sans mélanger espaces ni forges", async () => {
    const ta = createDevTaskRepo(db, a);
    const tb = createDevTaskRepo(db, b);
    const first = await ta.insert(ISSUE);
    await ta.update(first, { status: "mr_created", mr_iid: 7, mr_url: "u" });
    const followup = await ta.insert({ ...ISSUE, followup: { parentId: first, branch: "feature/609-x", baseBranch: "develop", targetBranch: "develop", mrIid: 7, mrUrl: "u" } });
    const other = await ta.insert({ ...ISSUE, issueIid: 700 });
    await ta.update(other, { status: "mr_created", mr_iid: 8, mr_url: "u" });

    expect((await ta.findByMergeRequest("gitlab", 1, 7))?.id).toBe(followup); // la reprise est la plus récente, même ticket
    expect((await ta.findByMergeRequest("gitlab", 1, 8))?.issue_iid).toBe(700);
    expect(await ta.findByMergeRequest("gitlab", 1, 99)).toBeUndefined();
    expect(await ta.findByMergeRequest("github", 1, 7)).toBeUndefined(); // autre forge
    expect(await tb.findByMergeRequest("gitlab", 1, 7)).toBeUndefined(); // autre espace
  });

  it("liste les essais d'un ticket, du plus ancien au plus récent, sans ceux d'un autre espace ni d'une autre forge", async () => {
    const ta = createDevTaskRepo(db, a);
    const tb = createDevTaskRepo(db, b);
    const first = await ta.insert(ISSUE);
    const second = await ta.insert(ISSUE);
    await ta.insert({ ...ISSUE, issueIid: 700 });
    await ta.insert({ ...ISSUE, source: "github" });
    await tb.insert(ISSUE);

    expect((await ta.listForIssue("gitlab", 1, 609)).map((x) => x.id)).toEqual([first, second]);
    expect((await ta.listForIssue("github", 1, 609)).length).toBe(1);
    expect((await tb.listForIssue("gitlab", 1, 609)).length).toBe(1);
  });
});
