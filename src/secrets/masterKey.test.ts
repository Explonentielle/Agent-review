import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretError, open, seal } from "./crypto.js";
import { KEY_FILE_NAME, resolveKeyring, type KeyringOptions } from "./masterKey.js";

describe("clé maître : où elle vit", () => {
  let dir: string;
  let options: KeyringOptions;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "masterkey-"));
    options = { masterKey: null, previousKeys: [], dataDir: path.join(dir, "data"), serverMode: false, hasSecrets: async () => false };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const keyFile = () => path.join(dir, "data", KEY_FILE_NAME);

  it("local sans clé : un fichier est créé au premier besoin, lisible par son propriétaire seul, puis réutilisé", async () => {
    expect(existsSync(keyFile())).toBe(false);
    const first = await resolveKeyring(options);
    expect(existsSync(keyFile())).toBe(true);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);

    const envelope = seal(first, "valeur", "ctx");
    const second = await resolveKeyring(options); // redémarrage : même clé
    expect(open(second, envelope, "ctx")).toBe("valeur");
    expect(second.currentKeyId).toBe(first.currentKeyId);
  });

  it("la clé du .env a priorité sur le fichier, qui n'est alors pas créé", async () => {
    const key = randomBytes(32).toString("base64");
    const keyring = await resolveKeyring({ ...options, masterKey: key });
    expect(existsSync(keyFile())).toBe(false);
    const viaEnv = await resolveKeyring({ ...options, masterKey: key });
    expect(open(viaEnv, seal(keyring, "v", "ctx"), "ctx")).toBe("v");
  });

  it("serveur : la clé du .env est obligatoire, aucun fichier n'est généré", async () => {
    await expect(resolveKeyring({ ...options, serverMode: true })).rejects.toThrow(/SECRETS_MASTER_KEY est obligatoire/);
    expect(existsSync(keyFile())).toBe(false);
    await expect(resolveKeyring({ ...options, serverMode: true, masterKey: randomBytes(32).toString("base64") })).resolves.toBeDefined();
  });

  it("clé perdue alors que des secrets existent : refus, jamais de nouvelle clé qui les rendrait illisibles", async () => {
    await expect(resolveKeyring({ ...options, hasSecrets: async () => true })).rejects.toThrow(/clé maître est introuvable/);
    expect(existsSync(keyFile())).toBe(false);
  });

  it("fichier de clé invalide : refus avec son chemin, sans afficher son contenu ni le remplacer", async () => {
    await resolveKeyring(options); // crée le fichier
    writeFileSync(keyFile(), "contenu-invalide-a-ne-pas-afficher\n");
    const err = await resolveKeyring(options).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(SecretError);
    expect(err!.message).toContain(KEY_FILE_NAME);
    expect(err!.message).not.toContain("contenu-invalide");
    expect(readFileSync(keyFile(), "utf8")).toBe("contenu-invalide-a-ne-pas-afficher\n");
  });

  it("rotation : la nouvelle clé chiffre, les anciennes (SECRETS_MASTER_KEY_PREVIOUS) déchiffrent encore", async () => {
    const oldKey = randomBytes(32).toString("base64");
    const newKey = randomBytes(32).toString("base64");
    const before = seal(await resolveKeyring({ ...options, masterKey: oldKey }), "ancien", "ctx");
    const rotated = await resolveKeyring({ ...options, masterKey: newKey, previousKeys: [oldKey] });
    expect(open(rotated, before, "ctx")).toBe("ancien");
    expect(rotated.currentKeyId).not.toBe((await resolveKeyring({ ...options, masterKey: oldKey })).currentKeyId);
    await expect(resolveKeyring({ ...options, masterKey: newKey, previousKeys: ["pas-une-cle"] })).rejects.toThrow(/32 octets/);
  });
});
