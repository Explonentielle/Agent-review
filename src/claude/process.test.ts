import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeEnv, runProcess } from "./process.js";

describe("environnement de l'agent", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const name of Object.keys(process.env)) delete process.env[name];
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("les secrets de l'outil n'arrivent jamais à l'agent, même sans nom évident", () => {
    Object.assign(process.env, {
      PATH: "/usr/bin",
      HOME: "/home/x",
      GITLAB_TOKEN: "jeton-gitlab",
      GITHUB_TOKEN: "jeton-github",
      PLANIO_API_KEY: "cle-planio",
      SECRETS_MASTER_KEY: "cle-maitre",
      SECRETS_MASTER_KEY_PREVIOUS: "ancienne-cle-maitre",
      DATABASE_URL: "postgres://review:motdepasse@db:5432/review_agent",
      AUTH_GITLAB_CLIENT_SECRET: "secret-oauth",
      AUTH_GITHUB_CLIENT_SECRET: "secret-oauth-2",
      NPM_TOKEN: "jeton-npm",
      AWS_SECRET_ACCESS_KEY: "cle-aws",
      CLAUDE_FAUX_PASSWORD: "x",
      ANTHROPIC_AUTH_TOKEN: "jeton-de-session",
      ANTHROPIC_API_KEY: "cle-du-shell",
    });
    const env = claudeEnv();

    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    expect(JSON.stringify(env)).not.toMatch(/jeton|cle-|secret|motdepasse/);
  });

  it("l'agent garde de quoi lancer des commandes et joindre le réseau", () => {
    Object.assign(process.env, {
      PATH: "/usr/bin", HOME: "/home/x", USER: "x", SHELL: "/bin/bash", LANG: "fr_FR.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm", TZ: "Europe/Paris", TMPDIR: "/tmp",
      HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "localhost", https_proxy: "http://proxy:3128", SSL_CERT_FILE: "/etc/ssl/ca.pem", NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
      XDG_CONFIG_HOME: "/home/x/.config", CLAUDE_CONFIG_DIR: "/home/x/.claude", ANTHROPIC_BASE_URL: "https://anthropic.example", ANTHROPIC_MODEL: "claude-sonnet-5-5",
    });
    expect(Object.keys(claudeEnv()).sort()).toEqual(Object.keys(process.env).sort());
  });

  it("la connexion à l'abonnement passe (CLAUDE_CODE_OAUTH_TOKEN) ; les autres variables inconnues ne passent pas", () => {
    Object.assign(process.env, { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "abonnement", VARIABLE_QUELCONQUE: "x", EDITOR: "vim", PWD: "/somewhere" });
    expect(claudeEnv()).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "abonnement" });
  });

  it("mode clé API : seule la clé choisie est transmise, celle du shell est ignorée", () => {
    Object.assign(process.env, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "cle-du-shell" });
    expect(claudeEnv().ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeEnv("cle-des-reglages").ANTHROPIC_API_KEY).toBe("cle-des-reglages");
  });
});

describe.skipIf(process.platform === "win32")("programme qui se termine sans lire son entrée", () => {
  it("rend son code et son stderr au lieu de faire tomber l'outil (docker qui échoue tout de suite)", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      const res = await runProcess("sh", ["-c", "echo 'image introuvable' >&2; exit 125"], "x".repeat(8_000_000), {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH },
        timeoutMs: 10_000,
      });
      expect(res.exitCode).toBe(125);
      expect(res.stderr).toContain("image introuvable");
      await new Promise((resolve) => setTimeout(resolve, 50)); // laisse arriver une éventuelle erreur d'écriture tardive
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
