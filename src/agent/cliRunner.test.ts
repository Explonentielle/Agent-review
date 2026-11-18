import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessCancelledError, agentRunConfig } from "../claude/process.js";
import { DEFAULT_SETTINGS } from "../settings/schema.js";
import { FORBIDDEN_RULES, buildAllowedTools, runDevAgent } from "../dev/engine.js";
import { reviewResultJsonSchema } from "../review/schema.js";
import { runReviewAgent } from "../review/engine.js";
import { CliRunner, buildCliArgs } from "./cliRunner.js";
import type { AgentRequest } from "./runner.js";

/**
 * Faux binaire `claude` : enregistre ses arguments, son entrée standard et la présence d'une clé API
 * dans son environnement, puis répond avec le contenu de `response.txt`. Aucun appel réel, aucun quota.
 */
let dir = "";
const read = (name: string) => readFileSync(path.join(dir, name), "utf8");

function installStub(response: string, body = 'cat "$dir/response.txt"'): string {
  const bin = path.join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'dir=$(dirname "$0")',
      'printf \'%s\\n\' "$@" > "$dir/args.txt"',
      'cat > "$dir/stdin.txt"',
      'env | grep -c \'^ANTHROPIC_API_KEY=\' > "$dir/key.txt"',
      'printenv ANTHROPIC_API_KEY > "$dir/keyval.txt"',
      'printenv ANTHROPIC_AUTH_TOKEN > "$dir/token.txt"',
      body,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  writeFileSync(path.join(dir, "response.txt"), response);
  return bin;
}

const reviewOk = {
  summary: "RAS",
  verdict: "approve",
  coverage: "full",
  ci_failure_related: false,
  injection_suspected: false,
  findings: [],
  positives: [],
  questions_for_author: [],
};
const devOk = { status: "done", summary: "Fait", commit_message: "Correction", tests: "Aucun", notes_for_reviewer: [], questions: [] };
const resultMsg = (structured: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: structured, total_cost_usd: 0.12, num_turns: 3, session_id: "sess-1", ...extra });

describe.skipIf(process.platform === "win32")("CliRunner avec un faux binaire claude", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "runner-test-"));
    process.env.ANTHROPIC_API_KEY = "cle-de-test-a-ne-jamais-transmettre";
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it("review : arguments attendus, prompt par l'entrée standard, clé API retirée, résultat validé", async () => {
    const runner = new CliRunner(installStub(resultMsg(reviewOk)));
    const out = await runReviewAgent({
      cwd: dir,
      systemPrompt: "SYSTEME",
      prompt: "CONTEXTE DE LA MR",
      engine: agentRunConfig(DEFAULT_SETTINGS.review),
      runner,
    });

    expect(out.result.verdict).toBe("approve");
    expect(out.costUsd).toBe(0.12);
    expect(out.numTurns).toBe(3);
    expect(read("stdin.txt")).toBe("CONTEXTE DE LA MR");
    expect(read("key.txt").trim()).toBe("0");
    expect(read("args.txt").trimEnd().split("\n")).toEqual([
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(reviewResultJsonSchema),
      "--model", "claude-sonnet-5-5",
      "--effort", "high",
      "--max-turns", "40",
      "--append-system-prompt", "SYSTEME",
      "--tools", "Read,Grep,Glob",
      "--allowedTools", "Read", "Grep", "Glob",
      "--disallowedTools", "mcp__*",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]);
  });

  it("dev : flux en direct, session et événements transmis, arguments attendus", async () => {
    const lines = [
      JSON.stringify({ type: "system", session_id: "sess-1" }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess-1",
        message: { content: [{ type: "text", text: "Je lis le fichier" }, { type: "tool_use", name: "Read", input: { file_path: path.join(dir, "a.js") } }] },
      }),
      "ligne qui n'est pas du JSON",
      resultMsg(devOk),
    ];
    const runner = new CliRunner(installStub(lines.join("\n") + "\n"));
    const events: string[] = [];
    const sessions: string[] = [];

    const out = await runDevAgent({
      cwd: dir,
      systemPrompt: "SYSTEME DEV",
      prompt: "TICKET",
      engine: agentRunConfig(DEFAULT_SETTINGS.dev),
      runner,
      allowedCommands: ["node test.js"],
      signal: new AbortController().signal,
      onEvent: (kind, text) => events.push(`${kind}:${text}`),
      onSession: (id) => sessions.push(id),
    });

    expect(out.result.status).toBe("done");
    expect(out.sessionId).toBe("sess-1");
    expect(sessions).toEqual(["sess-1"]);
    expect(events).toEqual(["text:Je lis le fichier", "tool:Read a.js"]);
    expect(read("args.txt").trimEnd().split("\n")).toEqual([
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", expect.any(String),
      "--model", "claude-sonnet-5-5",
      "--effort", "high",
      "--max-turns", "120",
      "--append-system-prompt", "SYSTEME DEV",
      "--tools", "Read,Grep,Glob,Edit,Write,Bash",
      "--allowedTools", ...buildAllowedTools(["node test.js"]),
      "--disallowedTools", ...FORBIDDEN_RULES,
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--safe-mode",
      "--strict-mcp-config",
    ]);
  });

  it("les protections ne dépendent pas de l'appelant : MCP interdit, mode sans invite, isolation du dépôt", () => {
    const req: AgentRequest = {
      cwd: dir,
      systemPrompt: "s",
      prompt: "p",
      outputSchema: {},
      tools: ["Read"],
      allowedTools: ["Read"],
      disallowedTools: [],
      model: "m",
      effort: "high",
      maxTurns: 1,
      timeoutMs: 1000,
      persistSession: true,
      stream: false,
    };
    const args = buildCliArgs(req);
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
    expect(args.slice(args.indexOf("--disallowedTools"), args.indexOf("--disallowedTools") + 2)).toEqual(["--disallowedTools", "mcp__*"]);
    expect(args).not.toContain("--no-session-persistence");
  });

  it("un agent sans aucun outil (Scribe) : « --tools » vide, pas de « --allowedTools » sans valeur, toutes les protections restent", () => {
    const req: AgentRequest = {
      cwd: dir,
      systemPrompt: "s",
      prompt: "p",
      outputSchema: {},
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      model: "m",
      effort: "high",
      maxTurns: 1,
      timeoutMs: 1000,
      persistSession: false,
      stream: false,
    };
    const args = buildCliArgs(req);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
    expect(args.slice(args.indexOf("--disallowedTools"), args.indexOf("--disallowedTools") + 2)).toEqual(["--disallowedTools", "mcp__*"]);
  });

  it("erreurs : échec de la CLI, sortie illisible, flux sans résultat, rapport invalide", async () => {
    const failing = new CliRunner(installStub(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "trop de tours" })));
    await expect(runReviewAgent({ cwd: dir, systemPrompt: "s", prompt: "p", engine: agentRunConfig(DEFAULT_SETTINGS.review), runner: failing })).rejects.toThrow(
      /Claude Code a échoué \(error_max_turns\) : trop de tours/,
    );

    const garbage = new CliRunner(installStub("pas du json"));
    await expect(runReviewAgent({ cwd: dir, systemPrompt: "s", prompt: "p", engine: agentRunConfig(DEFAULT_SETTINGS.review), runner: garbage })).rejects.toThrow(/Sortie de Claude Code illisible/);

    const noResult = new CliRunner(installStub(JSON.stringify({ type: "system", session_id: "x" }) + "\n"));
    await expect(
      runDevAgent({ cwd: dir, systemPrompt: "s", prompt: "p", engine: agentRunConfig(DEFAULT_SETTINGS.dev), runner: noResult, allowedCommands: [], signal: new AbortController().signal, onEvent: () => undefined, onSession: () => undefined }),
    ).rejects.toThrow(/sans résultat final/);

    const invalid = new CliRunner(installStub(resultMsg({ summary: "incomplet" })));
    await expect(runReviewAgent({ cwd: dir, systemPrompt: "s", prompt: "p", engine: agentRunConfig(DEFAULT_SETTINGS.review), runner: invalid })).rejects.toThrow(/Sortie structurée invalide/);
  });

  it("annulation : le processus est arrêté et l'erreur d'annulation est renvoyée", async () => {
    const runner = new CliRunner(installStub("", "exec sleep 30"));
    const ctrl = new AbortController();
    const promise = runDevAgent({
      cwd: dir,
      systemPrompt: "s",
      prompt: "p",
      engine: agentRunConfig(DEFAULT_SETTINGS.dev),
      runner,
      allowedCommands: [],
      signal: ctrl.signal,
      onEvent: () => undefined,
      onSession: () => undefined,
    });
    setTimeout(() => ctrl.abort(), 200);
    await expect(promise).rejects.toBeInstanceOf(ProcessCancelledError);
  });
});
