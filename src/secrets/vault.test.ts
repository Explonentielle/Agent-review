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
      ["gitlab.url", "env"],
      ["gitlab.token", "env"],
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
      ["gitlab.url", "env", false],
      ["gitlab.token", "env", false],
      ["github.token", "vault", false],
      ["anthropic.api_key", "vault", true],
    ]);
    expect(status[2]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
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
    expect((await describeSecrets(vault)).map((s) => s.source)).toEqual(["env", "env", null, null]);
  });

  it("seuls les secrets prévus se gèrent depuis le dashboard", () => {
    expect(managedName("github.token")).toBe("github.token");
    expect(managedName("gitlab.token")).toBe("gitlab.token");
    for (const bad of ["planio.api_key", "gitlab.password", "", "../x"]) expect(() => managedName(bad)).toThrow(/Secret inconnu/);
  });

  it("jeton GitLab personnel : contrôlé auprès de l'instance, le compte en est déduit, refusé s'il est invalide", async () => {
    const config = loadConfig({ GITLAB_URL: "https://gitlab.example", GITHUB_TOKEN: "github_pat_ENV_123456", DATA_DIR: "/tmp/x" }); // GitLab sans jeton dans le .env
    const checked: string[] = [];
    const local = await createAccountRepo(db).localContext();
    const vault = createVault(config, createSecretStore(db, new Keyring([randomBytes(32)])), { workspaceId: local.workspaceId, userId: local.userId }, async () => undefined, async (url, token) => {
      checked.push(`${url} ${token}`);
      if (token === "glpat-REFUSE-123456") throw new Error("401 Unauthorized");
      return "bob-gitlab";
    });
    expect((await describeSecrets(vault)).map((s) => [s.name, s.source])).toEqual([["gitlab.url", "env"], ["gitlab.token", null], ["github.token", "env"], ["anthropic.api_key", null]]);

    await expect(saveManagedSecret(config, vault, "gitlab.token", "glpat-REFUSE-123456")).rejects.toThrow(/401/);
    expect(await vault.store.has(vault.scope, "gitlab.token")).toBe(false);
    expect(await saveManagedSecret(config, vault, "gitlab.token", " glpat-BON-1234567 ")).toEqual({ restartRequired: true });
    expect(checked).toEqual(["https://gitlab.example glpat-REFUSE-123456", "https://gitlab.example glpat-BON-1234567"]);

    expect(config.gitlab).toBeNull();
    await applyVaultSecrets(config, vault); // au démarrage suivant : l'identifiant du compte vient de l'instance
    expect(config.gitlab).toEqual({ url: "https://gitlab.example", token: "glpat-BON-1234567", username: "bob-gitlab" });
    expect(await deleteManagedSecret(config, vault, "gitlab.token")).toEqual({ deleted: true, restartRequired: true });
  });

  it("sans adresse de GitLab, le jeton GitLab n'est pas proposé et ne peut pas être enregistré avant l'adresse", async () => {
    const config = loadConfig({ GITHUB_TOKEN: "github_pat_ENV_123456", DATA_DIR: "/tmp/x" });
    const local = await createAccountRepo(db).localContext();
    const vault = createVault(config, createSecretStore(db, new Keyring([randomBytes(32)])), { workspaceId: local.workspaceId, userId: local.userId }, async () => undefined, async () => "x");
    expect((await describeSecrets(vault)).map((s) => s.name)).toEqual(["gitlab.url", "github.token", "anthropic.api_key"]);
    await expect(saveManagedSecret(config, vault, "gitlab.token", "glpat-1234567890")).rejects.toThrow(/adresse de GitLab/);
  });

  it("adresse de GitLab saisie dans le dashboard, sans rien dans le .env : normalisée, appliquée au démarrage, le jeton GitLab devient saisissable", async () => {
    const config = loadConfig({ DATA_DIR: "/tmp/x" }); // .env sans aucune forge
    const local = await createAccountRepo(db).localContext();
    const scope = { workspaceId: local.workspaceId, userId: local.userId };
    const store = createSecretStore(db, new Keyring([randomBytes(32)]));
    const checked: string[] = [];
    const make = (c: Config) => createVault(c, store, scope, async () => undefined, async (url, token) => {
      checked.push(`${url} ${token}`);
      return "alex-gitlab";
    });
    const vault = make(config);

    expect((await describeSecrets(vault)).map((s) => [s.name, s.source, s.value])).toEqual([["gitlab.url", null, null], ["github.token", null, null], ["anthropic.api_key", null, null]]);
    expect(await saveManagedSecret(config, vault, "gitlab.url", "  https://gitlab.example.com/  ")).toEqual({ restartRequired: true });
    expect(config.gitlabUrl).toBe("https://gitlab.example.com");
    const after = await describeSecrets(vault);
    expect(after.map((s) => [s.name, s.source, s.value])).toEqual([["gitlab.url", "vault", "https://gitlab.example.com"], ["gitlab.token", null, null], ["github.token", null, null], ["anthropic.api_key", null, null]]);
    expect(after[0]!.secret).toBe(false);
    expect(after[1]!.secret).toBe(true);

    await saveManagedSecret(config, vault, "gitlab.token", "glpat-DU-COFFRE-123456");
    expect(checked).toEqual(["https://gitlab.example.com glpat-DU-COFFRE-123456"]);

    // Redémarrage : une configuration neuve retrouve l'adresse et le jeton dans le coffre
    const restarted = loadConfig({ DATA_DIR: "/tmp/x" });
    await applyVaultSecrets(restarted, make(restarted));
    expect(restarted.gitlabUrl).toBe("https://gitlab.example.com");
    expect(restarted.gitlab).toEqual({ url: "https://gitlab.example.com", token: "glpat-DU-COFFRE-123456", username: "alex-gitlab" });

    expect(await deleteManagedSecret(config, vault, "gitlab.url")).toEqual({ deleted: true, restartRequired: true });
    expect(config.gitlabUrl).toBeNull();
    expect((await describeSecrets(vault)).map((s) => s.name)).toEqual(["gitlab.url", "github.token", "anthropic.api_key"]);
  });

  it("adresse de GitLab : seules les adresses http(s) sans identifiants sont acceptées, et le .env reste prioritaire", async () => {
    const config = loadConfig({ DATA_DIR: "/tmp/x" });
    const vault = await vaultFor(config);
    for (const bad of ["gitlab.example.com", "ftp://gitlab.example.com", "javascript:alert(1)", "https://alex:secret@gitlab.example.com"]) {
      await expect(saveManagedSecret(config, vault, "gitlab.url", bad)).rejects.toThrow();
    }
    expect(await vault.store.has(vault.scope, "gitlab.url")).toBe(false);
    expect(await saveManagedSecret(config, vault, "gitlab.url", "https://exemple.org/gitlab/?x=1#y")).toEqual({ restartRequired: true });
    expect(config.gitlabUrl).toBe("https://exemple.org/gitlab"); // chemin gardé, paramètres retirés

    const fromEnv = loadConfig({ GITLAB_URL: "https://gitlab.env.example", DATA_DIR: "/tmp/x" });
    const envVault = await vaultFor(fromEnv);
    await expect(saveManagedSecret(fromEnv, envVault, "gitlab.url", "https://autre.example")).rejects.toThrow(SecretConflictError);
    await envVault.store.put(envVault.scope, "gitlab.url", "https://du-coffre.example");
    await applyVaultSecrets(fromEnv, envVault);
    expect(fromEnv.gitlabUrl).toBe("https://gitlab.env.example"); // le coffre n'écrase pas le .env
  });
});
