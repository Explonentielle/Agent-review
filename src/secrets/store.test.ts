import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountRepo } from "../db/accounts.js";
import type { Db } from "../db/db.js";
import { migrate } from "../db/migrations.js";
import { postgresFromPglite, type PgliteLike } from "../db/postgres.js";
import { openSqlite } from "../db/sqlite.js";
import { maskSecrets } from "../logger.js";
import { Keyring, SecretError, envelopeKeyId, seal } from "./crypto.js";
import { createSecretStore, hasAnySecret, type SecretScope } from "./store.js";

const backends: { name: string; open: () => Promise<Db> }[] = [
  { name: "SQLite", open: async () => openSqlite(":memory:") },
  { name: "PostgreSQL (PGlite)", open: async () => postgresFromPglite(new PGlite() as unknown as PgliteLike) },
];

describe.each(backends)("coffre à secrets : $name", ({ open }) => {
  let db: Db;
  let keyring: Keyring;
  let store: ReturnType<typeof createSecretStore>;
  let alice: SecretScope;
  let bob: SecretScope;
  let shared: SecretScope;
  let otherTeam: SecretScope;

  beforeAll(async () => {
    db = await open();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.run("DELETE FROM secrets");
    keyring = new Keyring([randomBytes(32)]);
    store = createSecretStore(db, keyring);
    const accounts = createAccountRepo(db);
    const local = await accounts.localContext();
    const bobId = await accounts.createUser({ name: "Bob" });
    const team = await accounts.createWorkspace({ name: "Autre équipe", kind: "team", adminUserId: bobId });
    alice = { workspaceId: local.workspaceId, userId: local.userId };
    shared = { workspaceId: local.workspaceId, userId: null };
    bob = { workspaceId: team, userId: bobId };
    otherTeam = { workspaceId: team, userId: null };
  });

  it("enregistrer, relire, remplacer, supprimer ; la base ne contient jamais la valeur en clair", async () => {
    expect(await store.get(alice, "github.token")).toBeNull();
    expect(await store.has(alice, "github.token")).toBe(false);

    await store.put(alice, "github.token", "github_pat_VALEUR_EN_CLAIR_1234");
    expect(await store.get(alice, "github.token")).toBe("github_pat_VALEUR_EN_CLAIR_1234");
    expect(await store.has(alice, "github.token")).toBe(true);

    const raw = await db.all<{ value: string }>("SELECT value FROM secrets");
    expect(raw).toHaveLength(1);
    expect(raw[0]!.value).toMatch(/^v1:/);
    expect(JSON.stringify(await db.all("SELECT * FROM secrets"))).not.toContain("VALEUR_EN_CLAIR");

    await store.put(alice, "github.token", "github_pat_REMPLACANT_5678"); // remplace sans doublon
    expect(await store.get(alice, "github.token")).toBe("github_pat_REMPLACANT_5678");
    expect(await db.all("SELECT id FROM secrets")).toHaveLength(1);

    expect(await store.delete(alice, "github.token")).toBe(true);
    expect(await store.delete(alice, "github.token")).toBe(false);
    expect(await store.get(alice, "github.token")).toBeNull();
  });

  it("étanchéité : un secret n'est visible que de son propriétaire (utilisateur, espace partagé, autre espace)", async () => {
    await store.put(alice, "github.token", "secret-d-alice-1234");
    await store.put(shared, "github.token", "secret-partage-1234");
    await store.put(bob, "github.token", "secret-de-bob-1234");

    expect(await store.get(alice, "github.token")).toBe("secret-d-alice-1234");
    expect(await store.get(shared, "github.token")).toBe("secret-partage-1234");
    expect(await store.get(bob, "github.token")).toBe("secret-de-bob-1234");
    expect(await store.get(otherTeam, "github.token")).toBeNull();
    // Même utilisateur, autre espace : rien
    expect(await store.get({ workspaceId: bob.workspaceId, userId: alice.userId }, "github.token")).toBeNull();

    expect((await store.list(alice)).map((s) => s.name)).toEqual(["github.token"]);
    expect(await store.list(otherTeam)).toEqual([]);
    expect(await store.delete(bob, "github.token")).toBe(true);
    expect(await store.get(alice, "github.token")).toBe("secret-d-alice-1234");
  });

  it("une valeur chiffrée recopiée dans une autre ligne est illisible (contexte authentifié)", async () => {
    await store.put(alice, "github.token", "secret-d-alice-1234");
    await store.put(bob, "github.token", "secret-de-bob-1234");
    const stolen = (await db.get<{ value: string }>("SELECT value FROM secrets WHERE user_id = ?", [alice.userId]))!.value;
    await db.run("UPDATE secrets SET value = ? WHERE user_id = ?", [stolen, bob.userId]);
    await expect(store.get(bob, "github.token")).rejects.toThrow(/illisible/);
    // Même chose en changeant le nom du secret
    await db.run("UPDATE secrets SET name = 'anthropic.api_key' WHERE user_id = ?", [alice.userId]);
    await expect(store.get(alice, "anthropic.api_key")).rejects.toThrow(/illisible/);
  });

  it("la liste ne montre que les noms et les dates, jamais les valeurs", async () => {
    await store.put(alice, "github.token", "valeur-confidentielle-1");
    await store.put(alice, "anthropic.api_key", "valeur-confidentielle-2");
    const list = await store.list(alice);
    expect(list.map((s) => s.name)).toEqual(["anthropic.api_key", "github.token"]);
    expect(Object.keys(list[0]!).sort()).toEqual(["name", "updated_at"]);
    expect(JSON.stringify(list)).not.toContain("confidentielle");
    expect(list[0]!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("noms et valeurs contrôlés ; erreurs sans fuite", async () => {
    for (const bad of ["", "Majuscule", "avec espace", "1chiffre", "a".repeat(65), "../etc"]) {
      await expect(store.put(alice, bad, "valeur")).rejects.toThrow(/Nom de secret invalide/);
    }
    await expect(store.put(alice, "github.token", "")).rejects.toThrow(SecretError);
    await expect(store.put(alice, "github.token", "x".repeat(8193))).rejects.toThrow(/entre 1 et 8192/);
    expect(await db.all("SELECT id FROM secrets")).toHaveLength(0);
  });

  it("les secrets lus ou enregistrés sont masqués dans les journaux et les messages d'erreur", async () => {
    await store.put(alice, "github.token", "ghp_MASQUE_DANS_LES_LOGS_9876");
    expect(maskSecrets("échec avec ghp_MASQUE_DANS_LES_LOGS_9876 dans l'URL")).toBe("échec avec [secret] dans l'URL");
  });

  it("un secret déjà en base (après un redémarrage) est masqué dès qu'il est lu", async () => {
    // Écrit hors du coffre, comme par une session précédente : seule la lecture peut le déclarer au journal
    const value = `ghp_ECRIT_PAR_UNE_SESSION_PRECEDENTE_${db.sql.name}`; // propre à chaque moteur : le journal garde les secrets déclarés pour tout le fichier de test
    const context = `review-agent:secret:${alice.workspaceId}:${alice.userId}:github.token`;
    await db.run("INSERT INTO secrets (workspace_id, user_id, name, value) VALUES (?, ?, 'github.token', ?)", [alice.workspaceId, alice.userId, seal(keyring, value, context)]);
    expect(maskSecrets(`erreur ${value}`)).toBe(`erreur ${value}`); // pas encore lu : le journal ne le connaît pas

    expect(await store.get(alice, "github.token")).toBe(value);
    expect(maskSecrets(`erreur ${value}`)).toBe("erreur [secret]");
  });

  it("hasAnySecret : détecte la présence sans rien lire", async () => {
    expect(await hasAnySecret(db)).toBe(false);
    await store.put(alice, "github.token", "valeur-quelconque-1");
    expect(await hasAnySecret(db)).toBe(true);
  });

  it("rotation de la clé maître : rechiffrement avec la nouvelle clé, valeurs et dates conservées", async () => {
    await store.put(alice, "github.token", "valeur-a-conserver-1");
    await store.put(shared, "anthropic.api_key", "valeur-a-conserver-2");
    const dates = await db.all("SELECT id, updated_at FROM secrets ORDER BY id");
    const oldKeyId = keyring.currentKeyId;

    const rotated = new Keyring([randomBytes(32), keyring.find(oldKeyId)!]);
    const rotatedStore = createSecretStore(db, rotated);
    expect(await rotatedStore.get(alice, "github.token")).toBe("valeur-a-conserver-1"); // l'ancienne clé suffit encore
    expect(await rotatedStore.reencryptAll()).toBe(2);
    expect(await rotatedStore.reencryptAll()).toBe(0); // rien à refaire

    for (const row of await db.all<{ value: string }>("SELECT value FROM secrets")) expect(envelopeKeyId(row.value)).toBe(rotated.currentKeyId);
    expect(await db.all("SELECT id, updated_at FROM secrets ORDER BY id")).toEqual(dates);
    // Sans l'ancienne clé, tout reste lisible : la nouvelle suffit maintenant
    const onlyNew = createSecretStore(db, new Keyring([rotated.find(rotated.currentKeyId)!]));
    expect(await onlyNew.get(alice, "github.token")).toBe("valeur-a-conserver-1");
    expect(await onlyNew.get(shared, "anthropic.api_key")).toBe("valeur-a-conserver-2");
  });
});
