import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountError, createAccountRepo, type AccountRepo } from "./accounts.js";
import { createCredentialRepo, type CredentialRepo } from "./credentials.js";
import type { Db } from "./db.js";
import { createEmailTokenRepo, type EmailTokenRepo } from "./emailTokens.js";
import { createInvitationRepo, type InvitationRepo } from "./invitations.js";
import { migrate } from "./migrations.js";
import { postgresFromPglite, type PgliteLike } from "./postgres.js";
import { openSqlite } from "./sqlite.js";

/* Mots de passe, liens envoyés par email, invitations par email, reprise du compte local. Mêmes tests sur SQLite et sur PostgreSQL (PGlite). */
const backends: Array<{ name: string; open(): Promise<Db> }> = [
  { name: "SQLite", open: async () => openSqlite(":memory:") },
  { name: "PostgreSQL (PGlite)", open: async () => postgresFromPglite(new PGlite() as unknown as PgliteLike) },
];

const TABLES = ["invitations", "email_tokens", "credentials", "memberships", "workspaces", "users"];

describe.each(backends)("connexion par email : $name", ({ open }) => {
  let db: Db;
  let accounts: AccountRepo;
  let credentials: CredentialRepo;
  let tokens: EmailTokenRepo;
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
    credentials = createCredentialRepo(db);
    tokens = createEmailTokenRepo(db);
    invitations = createInvitationRepo(db);
    alice = await accounts.createUser({ name: "Alice", email: "alice@example.com" });
    team = await accounts.createWorkspace({ name: "Équipe", kind: "team", adminUserId: alice });
  });

  describe("mots de passe", () => {
    it("s'enregistrent, se remplacent, et un compte sans mot de passe n'en a pas", async () => {
      expect(await credentials.get(alice)).toBeNull();
      await credentials.set(alice, "empreinte-1");
      expect(await credentials.get(alice)).toBe("empreinte-1");
      await credentials.set(alice, "empreinte-2");
      expect(await credentials.get(alice)).toBe("empreinte-2");
      expect(Number((await db.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM credentials"))!.n)).toBe(1);
    });

    it("ne sortent jamais d'une lecture des utilisateurs", async () => {
      await credentials.set(alice, "empreinte-secrete");
      expect(JSON.stringify(await db.all("SELECT * FROM users"))).not.toContain("empreinte-secrete");
      expect(JSON.stringify(await accounts.getUser(alice))).not.toContain("empreinte-secrete");
      expect(JSON.stringify(await accounts.listMembers(team))).not.toContain("empreinte-secrete");
    });
  });

  describe("liens envoyés par email", () => {
    it("un lien désigne son adresse et son compte, ne se stocke pas en clair et ne sert qu'à son usage", async () => {
      const token = await tokens.create({ purpose: "reset", email: "alice@example.com", userId: alice, minutes: 30 });
      expect(JSON.stringify(await db.all("SELECT * FROM email_tokens"))).not.toContain(token);
      expect(await tokens.peek("reset", token)).toEqual({ email: "alice@example.com", userId: alice });
      expect(await tokens.peek("signup", token)).toBeNull(); // un lien de mot de passe oublié n'ouvre pas une inscription
      expect(await tokens.peek("reset", "inconnu")).toBeNull();
      expect(await tokens.peek("reset", "x".repeat(300))).toBeNull();
    });

    it("se consomme une seule fois, même quand deux personnes l'utilisent en même temps", async () => {
      const token = await tokens.create({ purpose: "signup", email: "bob@example.com", minutes: 30 });
      const results = await Promise.all([tokens.consume("signup", token), tokens.consume("signup", token)]);
      expect(results.filter((r) => r !== null)).toEqual([{ email: "bob@example.com", userId: null }]);
      expect(await tokens.peek("signup", token)).toBeNull();
      expect(await tokens.consume("signup", token)).toBeNull();
    });

    it("n'est plus valable une fois expiré", async () => {
      const token = await tokens.create({ purpose: "reset", email: "alice@example.com", userId: alice, minutes: 30 });
      await db.run("UPDATE email_tokens SET expires_at = '2000-01-01 00:00:00'");
      expect(await tokens.peek("reset", token)).toBeNull();
      expect(await tokens.consume("reset", token)).toBeNull();
    });

    it("un nouveau lien annule le précédent pour la même adresse et le même usage, sans toucher aux autres", async () => {
      const first = await tokens.create({ purpose: "reset", email: "alice@example.com", userId: alice, minutes: 30 });
      const other = await tokens.create({ purpose: "reset", email: "bob@example.com", minutes: 30 });
      const second = await tokens.create({ purpose: "reset", email: "alice@example.com", userId: alice, minutes: 30 });
      expect(await tokens.peek("reset", first)).toBeNull();
      expect(await tokens.peek("reset", second)).not.toBeNull();
      expect(await tokens.peek("reset", other)).not.toBeNull();
    });

    it("le nettoyage retire les liens utilisés et expirés, et garde les autres", async () => {
      const used = await tokens.create({ purpose: "signup", email: "a@example.com", minutes: 30 });
      await tokens.consume("signup", used);
      const expired = await tokens.create({ purpose: "signup", email: "b@example.com", minutes: 30 });
      await db.run("UPDATE email_tokens SET expires_at = '2000-01-01 00:00:00' WHERE email = 'b@example.com'");
      const live = await tokens.create({ purpose: "signup", email: "c@example.com", minutes: 30 });
      expect(await tokens.purge()).toBe(2);
      expect(await tokens.peek("signup", live)).not.toBeNull();
      expect(await tokens.peek("signup", expired)).toBeNull();
    });
  });

  describe("invitations par email", () => {
    it("gardent l'adresse en minuscules, la rendent à la page d'invitation et à l'administrateur", async () => {
      const made = await invitations.create({ workspaceId: team, role: "member", email: "  Dan@Example.COM ", createdBy: alice });
      expect((await invitations.lookup(made.token))?.email).toBe("dan@example.com");
      expect((await invitations.listPending(team)).map((i) => i.email)).toEqual(["dan@example.com"]);
      expect((await invitations.create({ workspaceId: team, role: "member", createdBy: alice })).id).toBeGreaterThan(made.id);
      expect((await invitations.listPending(team)).map((i) => i.email)).toEqual([null, "dan@example.com"]); // la plus récente d'abord
    });

    it("refusent une adresse invalide, et une adresse donnée avec un compte de forge", async () => {
      await expect(invitations.create({ workspaceId: team, role: "member", email: "pas-une-adresse", createdBy: alice })).rejects.toThrow(AccountError);
      await expect(invitations.create({ workspaceId: team, role: "member", email: "dan@example.com", forgeLogin: "github:dan", createdBy: alice })).rejects.toThrow(/pas les deux/);
      expect(await invitations.listPending(team)).toEqual([]);
    });
  });

  describe("reprise du compte local par le propriétaire", () => {
    it("le compte local prend le nom et l'adresse, une seule fois, et jamais une adresse déjà prise", async () => {
      const local = await accounts.createUser({ name: "Utilisateur local" });
      expect(await accounts.claimLocalUser(local, { name: "Alex", email: "Alex@Example.com" })).toBe(true);
      expect(await accounts.getUser(local)).toMatchObject({ name: "Alex", email: "alex@example.com" });
      expect(await accounts.claimLocalUser(local, { name: "Autre", email: "autre@example.com" })).toBe(false); // déjà repris
      expect((await accounts.getUser(local))?.name).toBe("Alex");

      const free = await accounts.createUser({ name: "Local 2" });
      await expect(accounts.claimLocalUser(free, { name: "X", email: "alice@example.com" })).rejects.toThrow(/déjà utilisée/);
    });
  });
});
