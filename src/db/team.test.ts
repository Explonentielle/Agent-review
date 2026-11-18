import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSettingsStore } from "../settings/store.js";
import { AccountError, createAccountRepo, type AccountRepo } from "./accounts.js";
import { createCostRepo, currentMonth } from "./costs.js";
import type { Db } from "./db.js";
import { createDevTaskRepo } from "./devTasks.js";
import { INVITATION_DAYS, MAX_PENDING_INVITATIONS, createInvitationRepo, type InvitationRepo } from "./invitations.js";
import { migrate } from "./migrations.js";
import { postgresFromPglite, type PgliteLike } from "./postgres.js";
import { createReviewRepo } from "./reviews.js";
import { openSqlite } from "./sqlite.js";

/* Équipe : invitations, passage en espace d'équipe, limites par personne, attribution des reviews et des tâches. Mêmes tests sur SQLite et sur PostgreSQL (PGlite). */
const backends: Array<{ name: string; open(): Promise<Db> }> = [
  { name: "SQLite", open: async () => openSqlite(":memory:") },
  { name: "PostgreSQL (PGlite)", open: async () => postgresFromPglite(new PGlite() as unknown as PgliteLike) },
];

const TABLES = ["actions", "dev_task_events", "dev_tasks", "reviews", "projects", "settings", "secrets", "audit_log", "invitations", "email_tokens", "credentials", "memberships", "workspaces", "users"];
const ISSUE = { projectId: 1, projectPath: "g/p", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null };
const MR = { projectId: 1, projectPath: "g/p", mrTitle: "t", mrUrl: "u", author: "a" };

describe.each(backends)("équipe : $name", ({ open }) => {
  let db: Db;
  let accounts: AccountRepo;
  let invitations: InvitationRepo;
  let alice: number;
  let team: number;

  beforeAll(async () => {
    db = await open();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
    accounts = createAccountRepo(db);
    invitations = createInvitationRepo(db);
    alice = await accounts.createUser({ name: "Alice" });
    team = await accounts.createWorkspace({ name: "Équipe", kind: "team", adminUserId: alice });
  });

  describe("espace d'équipe", () => {
    it("un espace personnel devient une équipe, sans perdre ses données ni son rôle d'espace de l'installation", async () => {
      await db.run("DELETE FROM memberships"); // repart du compte local créé par la migration
      await db.run("DELETE FROM workspaces");
      await db.run("DELETE FROM users");
      await db.exec("INSERT INTO users (name) VALUES ('Utilisateur local'); INSERT INTO workspaces (name, kind) VALUES ('Espace local', 'personal');");
      const user = (await db.get<{ id: number }>("SELECT id FROM users"))!.id;
      const workspace = (await db.get<{ id: number }>("SELECT id FROM workspaces"))!.id;
      await db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'admin')", [workspace, user]);
      await createSettingsStore(db, workspace).saveProject({ projectId: 5, path: "g/b", devEnabled: false, baseBranch: "", targetBranch: "", allowedCommands: [], instructions: "" });

      await expect(accounts.addMember(workspace, await accounts.createUser({ name: "Bob" }), "member")).rejects.toThrow(/espace personnel/);
      await accounts.convertToTeam(workspace, "  Mon équipe ");
      expect(await accounts.getWorkspace(workspace)).toMatchObject({ kind: "team", name: "Mon équipe" });
      expect(await createSettingsStore(db, workspace).getProject("gitlab", 5)).not.toBeNull(); // les données sont restées en place
      expect(await accounts.localContext()).toEqual({ userId: user, workspaceId: workspace, role: "admin" }); // l'installation retrouve son espace
      await accounts.addMember(workspace, await accounts.createUser({ name: "Bob" }), "member"); // et on peut y ajouter du monde
      await expect(accounts.convertToTeam(workspace)).rejects.toThrow(/déjà un espace d'équipe/);
      await expect(accounts.convertToTeam(999_999)).rejects.toThrow(/introuvable/);
    });

    it("le nom est facultatif à la conversion : l'ancien est gardé, un nom invalide est refusé et rien ne change", async () => {
      const personal = await accounts.createWorkspace({ name: "Chez Alice", kind: "personal", adminUserId: alice });
      await expect(accounts.convertToTeam(personal, "x".repeat(101))).rejects.toThrow(/entre 1 et 100/);
      expect((await accounts.getWorkspace(personal))!.kind).toBe("personal");
      await accounts.convertToTeam(personal);
      expect(await accounts.getWorkspace(personal)).toMatchObject({ kind: "team", name: "Chez Alice" });
    });
  });

  describe("limites par membre", () => {
    it("les limites se fixent par membre, se reprennent à null, et sont validées", async () => {
      const bob = await accounts.createUser({ name: "Bob" });
      await accounts.addMember(team, bob, "member");
      expect((await accounts.listMembers(team)).find((m) => m.user_id === bob)).toMatchObject({ budget_usd: null, daily_runs: null });

      await accounts.setMemberQuota(team, bob, { budgetUsd: 12.5, dailyRuns: 3 });
      expect((await accounts.listMembers(team)).find((m) => m.user_id === bob)).toMatchObject({ budget_usd: 12.5, daily_runs: 3 });
      expect(await createCostRepo(db, team).memberQuota(bob)).toEqual({ budgetUsd: 12.5, dailyRuns: 3 });
      await accounts.setMemberQuota(team, bob, { budgetUsd: 0, dailyRuns: null }); // 0 : sans limite ; null : la valeur de l'espace
      expect(await createCostRepo(db, team).memberQuota(bob)).toEqual({ budgetUsd: 0, dailyRuns: null });

      for (const bad of [{ budgetUsd: -1, dailyRuns: null }, { budgetUsd: 100_001, dailyRuns: null }, { budgetUsd: Number.NaN, dailyRuns: null }, { budgetUsd: null, dailyRuns: 1.5 }, { budgetUsd: null, dailyRuns: -2 }, { budgetUsd: null, dailyRuns: 1001 }]) {
        await expect(accounts.setMemberQuota(team, bob, bad), JSON.stringify(bad)).rejects.toThrow(AccountError);
      }
      expect(await createCostRepo(db, team).memberQuota(bob)).toEqual({ budgetUsd: 0, dailyRuns: null }); // les refus n'ont rien changé
      await expect(accounts.setMemberQuota(team, 999_999, { budgetUsd: 1, dailyRuns: 1 })).rejects.toThrow(/pas membre/);
      const other = await accounts.createWorkspace({ name: "Autre", kind: "team", adminUserId: await accounts.createUser({ name: "Carol" }) });
      await expect(accounts.setMemberQuota(other, bob, { budgetUsd: 1, dailyRuns: 1 })).rejects.toThrow(/pas membre/); // un membre d'un autre espace n'est pas touché
    });

    it("les limites d'un membre sont propres à l'espace : la même personne peut en avoir d'autres ailleurs", async () => {
      const second = await accounts.createWorkspace({ name: "Deuxième", kind: "team", adminUserId: alice });
      await accounts.setMemberQuota(team, alice, { budgetUsd: 5, dailyRuns: 1 });
      expect(await createCostRepo(db, second).memberQuota(alice)).toEqual({ budgetUsd: null, dailyRuns: null });
      expect(await createCostRepo(db, team).memberQuota(999_999)).toEqual({ budgetUsd: null, dailyRuns: null }); // inconnu : aucune limite propre
    });
  });

  describe("propriétaire des reviews et des tâches, et consommation par personne", () => {
    it("chaque review et chaque tâche portent la personne qui les a créées ; sans personne, le propriétaire reste inconnu", async () => {
      const bob = await accounts.createUser({ name: "Bob" });
      await accounts.addMember(team, bob, "member");
      const aliceReviews = createReviewRepo(db, team, alice), bobReviews = createReviewRepo(db, team, bob), anonymous = createReviewRepo(db, team);
      const a = (await aliceReviews.insertIfNew({ ...MR, mrIid: 1, headSha: "a".repeat(40) }))!;
      const b = (await bobReviews.insertIfNew({ ...MR, mrIid: 2, headSha: "b".repeat(40) }))!;
      const n = (await anonymous.insertIfNew({ ...MR, mrIid: 3, headSha: "c".repeat(40) }))!;
      expect([(await anonymous.get(a))!.user_id, (await anonymous.get(b))!.user_id, (await anonymous.get(n))!.user_id]).toEqual([alice, bob, null]);

      const t = await createDevTaskRepo(db, team, bob).insert(ISSUE);
      expect((await createDevTaskRepo(db, team).get(t))!.user_id).toBe(bob);
      expect((await createDevTaskRepo(db, team).get(await createDevTaskRepo(db, team).insert({ ...ISSUE, issueIid: 1 })))!.user_id).toBeNull();
    });

    it("la consommation du mois est celle de la personne, dans l'espace, au mois de la fin ; les autres ne comptent pas", async () => {
      const bob = await accounts.createUser({ name: "Bob" });
      await accounts.addMember(team, bob, "member");
      const other = await accounts.createWorkspace({ name: "Autre", kind: "team", adminUserId: alice });
      const costs = createCostRepo(db, team);
      const month = currentMonth();

      const spend = async (workspaceId: number, userId: number, usd: number, kind: "review" | "dev", when?: string) => {
        if (kind === "review") {
          const id = (await createReviewRepo(db, workspaceId, userId).insertIfNew({ ...MR, mrIid: Math.floor(Math.random() * 1e6), headSha: Math.random().toString(16).slice(2).padEnd(40, "0") }))!;
          await db.run("UPDATE reviews SET cost_usd = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?", [usd, when ?? null, id]);
        } else {
          const id = await createDevTaskRepo(db, workspaceId, userId).insert({ ...ISSUE, issueIid: Math.floor(Math.random() * 1e6) });
          await db.run("UPDATE dev_tasks SET cost_usd = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?", [usd, when ?? null, id]);
        }
      };
      await spend(team, alice, 1.25, "review");
      await spend(team, alice, 2, "dev");
      await spend(team, bob, 10, "dev");
      await spend(other, alice, 100, "dev"); // un autre espace : jamais compté
      await spend(team, alice, 50, "dev", "2020-01-15 10:00:00"); // un autre mois : pas compté

      expect(await costs.userMonthTotal(alice, month)).toBeCloseTo(3.25, 6);
      expect(await costs.userMonthTotal(bob, month)).toBeCloseTo(10, 6);
      expect(await costs.userMonthTotal(alice, "2020-01")).toBeCloseTo(50, 6);
      expect(await costs.userMonthTotal(999_999, month)).toBe(0);
      expect(await createCostRepo(db, other).userMonthTotal(alice, month)).toBeCloseTo(100, 6);
      expect(await costs.monthTotal(month)).toBeCloseTo(13.25, 6); // le total de l'espace est la somme des personnes (et des lignes sans propriétaire)
    });

    it("les lancements du jour sont ceux de la personne depuis minuit UTC, reviews et tâches ensemble", async () => {
      const bob = await accounts.createUser({ name: "Bob" });
      await accounts.addMember(team, bob, "member");
      const costs = createCostRepo(db, team);
      const now = new Date("2026-11-18T15:30:00Z");
      const rows = await Promise.all([
        createDevTaskRepo(db, team, alice).insert(ISSUE),
        createDevTaskRepo(db, team, alice).insert({ ...ISSUE, issueIid: 2 }),
        createDevTaskRepo(db, team, alice).insert({ ...ISSUE, issueIid: 3 }),
      ]);
      const review = (await createReviewRepo(db, team, alice).insertIfNew({ ...MR, mrIid: 7, headSha: "d".repeat(40) }))!;
      const bobs = await createDevTaskRepo(db, team, bob).insert({ ...ISSUE, issueIid: 4 });
      await db.run("UPDATE dev_tasks SET created_at = '2026-11-18 09:00:00' WHERE id IN (?, ?, ?)", [rows[0]!, bobs, rows[1]!]);
      await db.run("UPDATE dev_tasks SET created_at = '2026-11-17 23:59:59' WHERE id = ?", [rows[2]!]); // la veille : ne compte pas
      await db.run("UPDATE reviews SET created_at = '2026-11-18 00:00:00' WHERE id = ?", [review]);

      expect(await costs.userRunsToday(alice, now)).toBe(3); // deux tâches du jour et une review
      expect(await costs.userRunsToday(bob, now)).toBe(1);
      expect(await costs.userRunsToday(alice, new Date("2026-11-19T00:00:01Z"))).toBe(0);
      expect(await createCostRepo(db, await accounts.createWorkspace({ name: "Autre", kind: "team", adminUserId: alice })).userRunsToday(alice, now)).toBe(0);
    });
  });

  describe("invitations", () => {
    it("une invitation donne un jeton unique, jamais stocké, et se lit sans le révéler", async () => {
      const made = await invitations.create({ workspaceId: team, role: "member", note: "  Pour Bob  ", forgeLogin: "GitHub:Bob-Dev", createdBy: alice });
      expect(made.token.length).toBeGreaterThanOrEqual(43);
      expect(JSON.stringify(await db.all("SELECT * FROM invitations"))).not.toContain(made.token);
      expect((await invitations.create({ workspaceId: team, role: "member", createdBy: alice })).token).not.toBe(made.token);

      const found = await invitations.lookup(made.token);
      expect(found).toMatchObject({ id: made.id, workspaceId: team, workspaceName: "Équipe", role: "member", note: "Pour Bob", forgeLogin: "github:bob-dev", invitedBy: "Alice" });
      const pending = await invitations.listPending(team);
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.id)).toEqual([pending[0]!.id, pending[1]!.id].sort((x, y) => y - x)); // la plus récente d'abord
      expect(JSON.stringify(pending)).not.toContain(made.token);
      expect(made.expiresAt > new Date(Date.now() + (INVITATION_DAYS - 1) * 86_400_000).toISOString().slice(0, 19).replace("T", " ")).toBe(true);
    });

    it("refuse ce qui n'a pas de sens : rôle inconnu, compte de forge mal écrit, durée hors bornes, note trop longue, espace personnel ou inconnu", async () => {
      const personal = await accounts.createWorkspace({ name: "Chez Bob", kind: "personal", adminUserId: await accounts.createUser({ name: "Bob" }) });
      const bad: Array<[string, Parameters<InvitationRepo["create"]>[0]]> = [
        ["rôle", { workspaceId: team, role: "root", createdBy: alice }],
        ["compte de forge sans forge", { workspaceId: team, role: "member", forgeLogin: "bob", createdBy: alice }],
        ["compte de forge inconnu", { workspaceId: team, role: "member", forgeLogin: "bitbucket:bob", createdBy: alice }],
        ["compte de forge avec espace", { workspaceId: team, role: "member", forgeLogin: "github:bob dev", createdBy: alice }],
        ["durée nulle", { workspaceId: team, role: "member", days: 0, createdBy: alice }],
        ["durée trop longue", { workspaceId: team, role: "member", days: 31, createdBy: alice }],
        ["durée fractionnaire", { workspaceId: team, role: "member", days: 1.5, createdBy: alice }],
        ["note trop longue", { workspaceId: team, role: "member", note: "x".repeat(201), createdBy: alice }],
        ["espace personnel", { workspaceId: personal, role: "member", createdBy: alice }],
        ["espace inconnu", { workspaceId: 999_999, role: "member", createdBy: alice }],
      ];
      for (const [label, input] of bad) await expect(invitations.create(input), label).rejects.toThrow(AccountError);
      expect(await db.all("SELECT 1 FROM invitations")).toHaveLength(0);
    });

    it("un espace garde au plus 50 invitations en attente ; en révoquer une libère une place", async () => {
      for (let i = 0; i < MAX_PENDING_INVITATIONS; i++) await invitations.create({ workspaceId: team, role: "viewer", createdBy: alice });
      await expect(invitations.create({ workspaceId: team, role: "viewer", createdBy: alice })).rejects.toThrow(/50 invitations/);
      const second = await accounts.createWorkspace({ name: "Autre", kind: "team", adminUserId: alice });
      await invitations.create({ workspaceId: second, role: "viewer", createdBy: alice }); // le plafond est par espace
      await invitations.revoke(team, (await invitations.listPending(team))[0]!.id);
      await invitations.create({ workspaceId: team, role: "viewer", createdBy: alice });
    });

    it("une invitation sert une seule fois : de deux personnes en même temps, une seule l'obtient", async () => {
      const made = await invitations.create({ workspaceId: team, role: "member", createdBy: alice });
      const bob = await accounts.createUser({ name: "Bob" }), carol = await accounts.createUser({ name: "Carol" });
      const results = await Promise.all([invitations.consume(made.id, bob), invitations.consume(made.id, carol)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await invitations.lookup(made.token)).toBeNull(); // plus valable une fois utilisée
      expect(await invitations.listPending(team)).toHaveLength(0);
      expect(await invitations.consume(made.id, bob)).toBe(false);
      const used = await db.get<{ used_by: number; used_at: string }>("SELECT used_by, used_at FROM invitations WHERE id = ?", [made.id]);
      expect([bob, carol]).toContain(used!.used_by);
      expect(used!.used_at).toBeTruthy();
    });

    it("révoquée, expirée ou inconnue : le même refus, et aucune ne peut être consommée", async () => {
      const revoked = await invitations.create({ workspaceId: team, role: "member", createdBy: alice });
      const expired = await invitations.create({ workspaceId: team, role: "member", createdBy: alice });
      const valid = await invitations.create({ workspaceId: team, role: "member", createdBy: alice });
      const bob = await accounts.createUser({ name: "Bob" });

      await invitations.revoke(team, revoked.id);
      await db.run("UPDATE invitations SET expires_at = '2000-01-01 00:00:00' WHERE id = ?", [expired.id]);
      for (const gone of [revoked, expired]) {
        expect(await invitations.lookup(gone.token)).toBeNull();
        expect(await invitations.consume(gone.id, bob)).toBe(false);
      }
      for (const token of ["", "inconnu", "x".repeat(201), valid.token + "a", valid.token.slice(1)]) expect(await invitations.lookup(token), token.slice(0, 10)).toBeNull();
      expect((await invitations.listPending(team)).map((p) => p.id)).toEqual([valid.id]);
      expect(await invitations.lookup(valid.token)).not.toBeNull();
    });

    it("on ne révoque que dans son espace, une seule fois, et jamais une invitation déjà utilisée", async () => {
      const second = await accounts.createWorkspace({ name: "Autre", kind: "team", adminUserId: alice });
      const mine = await invitations.create({ workspaceId: team, role: "member", createdBy: alice });
      await expect(invitations.revoke(second, mine.id)).rejects.toThrow(/introuvable/); // l'administrateur d'un autre espace n'y touche pas
      expect(await invitations.lookup(mine.token)).not.toBeNull();
      await invitations.revoke(team, mine.id);
      await expect(invitations.revoke(team, mine.id)).rejects.toThrow(/déjà utilisée/);
      const used = await invitations.create({ workspaceId: team, role: "member", createdBy: alice });
      await invitations.consume(used.id, await accounts.createUser({ name: "Bob" }));
      await expect(invitations.revoke(team, used.id)).rejects.toThrow(AccountError);
      await expect(invitations.revoke(team, 999_999)).rejects.toThrow(AccountError);
    });
  });
});
