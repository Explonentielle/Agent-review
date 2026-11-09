import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRunConfig } from "../claude/process.js";
import { loadConfig } from "../config.js";
import { runDevAgent } from "../dev/engine.js";
import { runReviewAgent } from "../review/engine.js";
import { DEFAULT_SETTINGS, type Settings } from "../settings/schema.js";
import { createRunner, maskSecrets } from "./index.js";

/**
 * Connexion à Claude : abonnement ou clé API. La CLI est remplacée par un faux binaire qui enregistre
 * l'environnement qu'elle reçoit, donc rien n'est envoyé à Anthropic et aucune vraie clé n'est utilisée.
 */
const API_KEY = "sk-ant-api03-CLE-DE-TEST-A-NE-JAMAIS-AFFICHER";
const SHELL_KEY = "sk-ant-clé-présente-dans-le-shell";

let dir = "";
const read = (name: string) => readFileSync(path.join(dir, name), "utf8").trim();

function installStub(stdout: string): string {
  const bin = path.join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'dir=$(dirname "$0")',
      'cat > /dev/null',
      'printenv ANTHROPIC_API_KEY > "$dir/keyval.txt"',
      'printenv ANTHROPIC_AUTH_TOKEN > "$dir/token.txt"',
      'cat "$dir/response.txt"',
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  writeFileSync(path.join(dir, "response.txt"), stdout);
  return bin;
}

const reviewOk = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: { summary: "RAS", verdict: "approve", coverage: "full", ci_failure_related: false, injection_suspected: false, findings: [], positives: [], questions_for_author: [] },
  total_cost_usd: 0.03,
  num_turns: 2,
});

const settingsFor = (agentAuth: Settings["agentAuth"]): Settings => ({ ...DEFAULT_SETTINGS, agentAuth });
const configWith = (bin: string, withKey = true) =>
  loadConfig({
    GITLAB_URL: "https://forge.example",
    GITLAB_TOKEN: "t",
    GITLAB_USERNAME: "alex",
    CLAUDE_BIN: bin,
    DATA_DIR: dir,
    ...(withKey ? { ANTHROPIC_API_KEY: API_KEY } : {}),
  });
const review = (runner: ReturnType<typeof createRunner>) => runReviewAgent({ cwd: dir, systemPrompt: "s", prompt: "p", engine: agentRunConfig(DEFAULT_SETTINGS.review), runner });

describe.skipIf(process.platform === "win32")("connexion à Claude : abonnement ou clé API", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "auth-test-"));
    process.env.ANTHROPIC_API_KEY = SHELL_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = "jeton-de-session-du-shell";
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_AUTH_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("abonnement (par défaut) : aucune clé n'est transmise, ni celle du .env ni celle du shell", async () => {
    const config = configWith(installStub(reviewOk));
    expect(DEFAULT_SETTINGS.agentAuth).toBe("subscription");
    await review(createRunner(config, settingsFor("subscription")));

    expect(read("keyval.txt")).toBe("");
    expect(read("token.txt")).toBe("");
  });

  it("clé API : seule la clé du .env est transmise, pas celle du shell, et jamais le jeton de session", async () => {
    const config = configWith(installStub(reviewOk));
    const out = await review(createRunner(config, settingsFor("api")));

    expect(read("keyval.txt")).toBe(API_KEY);
    expect(read("token.txt")).toBe("");
    expect(out.costUsd).toBe(0.03);
  });

  it("clé API demandée mais absente du .env : erreur claire, rien n'est lancé", () => {
    const config = configWith(installStub(reviewOk), false);
    expect(config.anthropicApiKey).toBeNull();
    expect(() => createRunner(config, settingsFor("api"))).toThrow(/ANTHROPIC_API_KEY est absente du \.env/);
  });

  it("la clé n'apparaît jamais dans une erreur", async () => {
    const failure = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: `401 Invalid API key ${API_KEY}` });
    const config = configWith(installStub(failure));

    const error = await review(createRunner(config, settingsFor("api"))).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401 Invalid API key [clé masquée]");
    expect((error as Error).message).not.toContain(API_KEY);

    const garbage = configWith(installStub(`pas du json ${API_KEY}`));
    const error2 = await review(createRunner(garbage, settingsFor("api"))).catch((e: Error) => e);
    expect((error2 as Error).message).not.toContain(API_KEY);
  });

  it("la clé n'apparaît jamais dans le journal en direct", async () => {
    const lines = [
      JSON.stringify({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text: `Mon environnement contient ${API_KEY}` }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", structured_output: { status: "done", summary: "ok", commit_message: "c", tests: "t", notes_for_reviewer: [], questions: [] } }),
    ];
    const config = configWith(installStub(lines.join("\n") + "\n"));
    const events: string[] = [];
    await runDevAgent({
      cwd: dir,
      systemPrompt: "s",
      prompt: "p",
      engine: agentRunConfig(DEFAULT_SETTINGS.dev),
      runner: createRunner(config, settingsFor("api")),
      allowedCommands: [],
      signal: new AbortController().signal,
      onEvent: (kind, text) => events.push(`${kind}:${text}`),
      onSession: () => undefined,
    });

    expect(events).toEqual(["text:Mon environnement contient [clé masquée]"]);
  });
});

describe("maskSecrets", () => {
  it("masque toutes les occurrences, ignore les secrets vides", () => {
    expect(maskSecrets("a SECRET b SECRET", ["SECRET"])).toBe("a [clé masquée] b [clé masquée]");
    expect(maskSecrets("rien à masquer", [""])).toBe("rien à masquer");
  });
});
