import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config.js";
import { createAccountRepo } from "../db/accounts.js";
import type { Db } from "../db/db.js";
import { migrate } from "../db/migrations.js";
import { openSqlite } from "../db/sqlite.js";
import { Keyring } from "./crypto.js";
import { createSecretStore } from "./store.js";
import { SecretConflictError, applyVaultSecrets, createVault, deleteManagedSecret, describeSecrets, managedName, saveManagedSecret, type Vault } from "./vault.js";

const GITLAB = { GITLAB_URL: "https://forge.example", GITLAB_TOKEN: "jeton-gitlab-factice", GITLAB_USERNAME: "alex" };

describe("coffre : secrets du dashboard et du .env", () => {
  let db: Db;
  let verified: { apiUrl: string; token: string }[];
  let refuse: boolean;

  beforeEach(async () => {
    db = openSqlite(":memory:");
    await migrate(db);
    verified = [];
    refuse = false;
  });
  afterEach(async () => {
    await db.close();
  });

  /** Coffre sur la base de test, pour une configuration donnée ; le contrôle GitHub est simulé. */
  async function vaultFor(config: Config, keyring = new Keyring([randomBytes(32)])): Promise<Vault> {
    const local = await createAccountRepo(db).localContext();
    return createVault(config, createSecretStore(db, keyring), { workspaceId: local.workspaceId, userId: local.userId }, async (apiUrl, token) => {
      verified.push({ apiUrl, token });
      if (refuse) throw new Error("GitHub a refusé le jeton");
    });
  }

  it("au démarrage : le jeton GitHub et la clé API du coffre complètent la configuration", async () => {
    const config = loadConfig({ ...GITLAB, DATA_DIR: "/tmp/x" });
    const vault = await vaultFor(config);
    await vault.store.put(vault.scope, "github.token", "github_pat_DU_COFFRE_1234");
    await vault.store.put(vault.scope, "anthropic.api_key", "sk-ant-DU-COFFRE-1234");
    expect(config.github).toBeNull();
    expect(config.anthropicApiKey).toBeNull();

    await applyVaultSecrets(config, vault);

    expect(config.github).toEqual({ apiUrl: "https://api.github.com", token: "github_pat_DU_COFFRE_1234" });
    expect(config.anthropicApiKey).toBe("sk-ant-DU-COFFRE-1234");
    expect(verified).toEqual([{ apiUrl: "https://api.github.com", token: "github_pat_DU_COFFRE_1234" }]);
  });

  it("le .env est prioritaire : le coffre n'écrase rien et n'est même pas lu", async () => {
    const config = loadConfig({ ...GITLAB, GITHUB_TOKEN: "github_pat_DU_ENV_123456", ANTHROPIC_API_KEY: "sk-ant-DU-ENV-123456", DATA_DIR: "/tmp/x" });
    const vault = await vaultFor(config);
    await vault.store.put(vault.scope, "github.token", "github_pat_DU_COFFRE_1234");
    await vault.store.put(vault.scope, "anthropic.api_key", "sk-ant-DU-COFFRE-1234");

    await applyVaultSecrets(config, vault);

    expect(config.github?.token).toBe("github_pat_DU_ENV_123456");
    expect(config.anthropicApiKey).toBe("sk-ant-DU-ENV-123456");
    expect(verified).toEqual([]);
    expect((await describeSecrets(vault)).map((s) => [s.name, s.source])).toEqual([
      ["github.token", "env"],
      ["anthropic.api_key", "env"],
    ]);
    await expect(saveManagedSecret(config, vault, "github.token", "autre-jeton-12345")).rejects.toThrow(SecretConflictError);
    await expect(deleteManagedSecret(config, vault, "anthropic.api_key")).rejects.toThrow(SecretConflictError);
  });

  it("un jeton GitHub refusé ou un secret illisible ne bloquent pas le démarrage : la forge est ignorée", async () => {
    const config = loadConfig({ ...GITLAB, DATA_DIR: "/tmp/x" });
    const vault = await vaultFor(config);
    await vault.store.put(vault.scope, "github.token", "github_pat_REFUSE_123456");
    refuse = true;
    await applyVaultSecrets(config, vault);
    expect(config.github).toBeNull();

    // Clé maître perdue : le secret existe mais ne se déchiffre plus
    const other = await vaultFor(loadConfig({ ...GITLAB, DATA_DIR: "/tmp/x" }), new Keyring([randomBytes(32)]));
    await other.store.put(other.scope, "anthropic.api_key", "sk-ant-ILLISIBLE-12345");
    const lost = createVault(config, createSecretStore(db, new Keyring([randomBytes(32)])), other.scope, async () => undefined);
    await applyVaultSecrets(config, lost);
    expect(config.anthropicApiKey).toBeNull();
  });

  it("enregistrer : la clé API sert tout de suite, le jeton GitHub est contrôlé puis attend un redémarrage", async () => {
    const config = loadConfig({ ...GITLAB, DATA_DIR: "/tmp/x" });
    const vault = await vaultFor(config);

    expect(await saveManagedSecret(config, vault, "anthropic.api_key", "  sk-ant-SAISIE-123456  ")).toEqual({ restartRequired: false });
    expect(config.anthropicApiKey).toBe("sk-ant-SAISIE-123456"); // espaces retirés, appliquée sans redémarrage

    expect(await saveManagedSecret(config, vault, "github.token", "github_pat_SAISI_123456")).toEqual({ restartRequired: true });
    expect(verified).toEqual([{ apiUrl: "https://api.github.com", token: "github_pat_SAISI_123456" }]);
    expect(config.github).toBeNull(); // la forge n'est montée qu'au démarrage

    const status = await describeSecrets(vault);
    expect(status.map((s) => [s.name, s.source, s.live])).toEqual([
      ["github.token", "vault", false],
      ["anthropic.api_key", "vault", true],
    ]);
    expect(status[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(JSON.stringify(status)).not.toContain("SAISI");
  });

  it("un jeton GitHub refusé n'est pas enregistré (il empêcherait la forge de démarrer)", async () => {
    const config = loadConfig({ ...GITLAB, DATA_DIR: "/tmp/x" });
    const vault = await vaultFor(config);
    refuse = true;
    await expect(saveManagedSecret(config, vault, "github.token", "github_pat_REFUSE_123456")).rejects.toThrow(/refusé/);
    expect(await vault.store.has(vault.scope, "github.token")).toBe(false);
  });

  it("supprimer : la clé API cesse de servir tout de suite, le jeton GitHub au redémarrage", async () => {
    const config = loadConfig({ ...GITLAB, DATA_DIR: "/tmp/x" });
    const vault = await vaultFor(config);
    await saveManagedSecret(config, vault, "anthropic.api_key", "sk-ant-A-SUPPRIMER-1");
    await saveManagedSecret(config, vault, "github.token", "github_pat_A_SUPPRIMER_1");

    expect(await deleteManagedSecret(config, vault, "anthropic.api_key")).toEqual({ deleted: true, restartRequired: false });
    expect(config.anthropicApiKey).toBeNull();
    expect(await deleteManagedSecret(config, vault, "github.token")).toEqual({ deleted: true, restartRequired: true });
    expect(await deleteManagedSecret(config, vault, "github.token")).toEqual({ deleted: false, restartRequired: false });
    expect((await describeSecrets(vault)).map((s) => s.source)).toEqual([null, null]);
  });

  it("seuls les secrets prévus se gèrent depuis le dashboard", () => {
    expect(managedName("github.token")).toBe("github.token");
    for (const bad of ["gitlab.token", "planio.api_key", "", "../x"]) expect(() => managedName(bad)).toThrow(/Secret inconnu/);
  });
});
