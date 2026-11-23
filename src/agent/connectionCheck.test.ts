import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerSecret } from "../logger.js";
import { checkClaudeConnection, createConnectionCheckCache, type ConnectionCheck } from "./connectionCheck.js";
import type { AgentRequest, AgentRunner } from "./runner.js";

/* Test réel de la connexion à Claude : une demande minimale sans outil, et un constat lisible selon ce que répond l'exécuteur. */
const REFUSAL = "Claude Code a échoué (success) : Failed to authenticate. API Error: 401 Invalid bearer token";

function runnerThat(behavior: (req: AgentRequest) => void | Promise<void>): { runner: AgentRunner; requests: AgentRequest[] } {
  const requests: AgentRequest[] = [];
  return {
    requests,
    runner: { run: async (req) => { requests.push(req); await behavior(req); return { structured: { ok: true }, sessionId: null, costUsd: 0.01, numTurns: 1 }; } },
  };
}

describe("test réel de la connexion à Claude", () => {
  it("une demande acceptée donne « ok » : sans aucun outil, avec le modèle demandé, dans un dossier temporaire supprimé ensuite", async () => {
    const { runner, requests } = runnerThat(() => undefined);
    const check = await checkClaudeConnection({ makeRunner: () => runner, mode: "subscription", model: "claude-sonnet-5-5", now: () => 1234 });
    expect(check).toMatchObject({ ok: true, kind: "ok", mode: "subscription", checkedAt: 1234 });
    expect(check.detail).toContain("jeton d'abonnement");
    const req = requests[0]!;
    expect(req.tools).toEqual([]);
    expect(req.allowedTools).toEqual([]);
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.effort).toBe("low");
    expect(req.persistSession).toBe(false);
    expect(existsSync(req.cwd)).toBe(false);
  });

  it("un 401 du jeton d'abonnement est dit « refusé » et explique comment le refaire", async () => {
    const { runner } = runnerThat(() => { throw new Error(REFUSAL); });
    const check = await checkClaudeConnection({ makeRunner: () => runner, mode: "subscription", model: "m" });
    expect(check).toMatchObject({ ok: false, kind: "refused" });
    expect(check.detail).toContain("claude setup-token");
    expect(check.detail).toContain("en entier");
  });

  it("un 401 de la clé API parle de la clé, pas du jeton d'abonnement", async () => {
    const { runner } = runnerThat(() => { throw new Error("API Error: 401 invalid x-api-key"); });
    const check = await checkClaudeConnection({ makeRunner: () => runner, mode: "api", model: "m" });
    expect(check).toMatchObject({ ok: false, kind: "refused", mode: "api" });
    expect(check.detail).toContain("clé API");
    expect(check.detail).not.toContain("setup-token");
  });

  it("un autre échec (Docker, image, délai) n'est pas pris pour un refus d'Anthropic", async () => {
    const { runner } = runnerThat(() => { throw new Error("Image « review-agent-agent » introuvable sur ce Docker"); });
    const check = await checkClaudeConnection({ makeRunner: () => runner, mode: "subscription", model: "m" });
    expect(check).toMatchObject({ ok: false, kind: "error" });
    expect(check.detail).toContain("introuvable sur ce Docker");
  });

  it("un exécuteur impossible à créer (aucun jeton) est dit « absent », sans rien lancer", async () => {
    const check = await checkClaudeConnection({ makeRunner: () => { throw new Error("Le mode « abonnement » en conteneur demande ton jeton d'abonnement"); }, mode: "subscription", model: "m" });
    expect(check).toMatchObject({ ok: false, kind: "missing" });
    expect(check.detail).toContain("jeton d'abonnement");
  });

  it("le constat ne contient jamais le secret, même si l'erreur de l'exécuteur le répète", async () => {
    const secret = "sk-ant-oat01-SECRET-DU-TEST-1234567890";
    registerSecret(secret);
    const { runner } = runnerThat(() => { throw new Error(`échec inattendu avec ${secret}`); });
    const check = await checkClaudeConnection({ makeRunner: () => runner, mode: "subscription", model: "m" });
    expect(check.kind).toBe("error");
    expect(check.detail).not.toContain(secret);
  });

  it("le dossier temporaire est supprimé aussi quand le test échoue", async () => {
    let cwd = "";
    const { runner } = runnerThat((req) => { cwd = req.cwd; throw new Error(REFUSAL); });
    await checkClaudeConnection({ makeRunner: () => runner, mode: "subscription", model: "m" });
    expect(cwd).not.toBe("");
    expect(existsSync(cwd)).toBe(false);
  });
});

describe("mémoire courte des tests", () => {
  const verdict = (kind: ConnectionCheck["kind"] = "ok"): ConnectionCheck => ({ ok: kind === "ok", kind, mode: "subscription", detail: "d", checkedAt: 1 });

  it("un clic répété pendant la durée de mémoire ne relance pas l'agent ; un autre jeton le relance tout de suite", async () => {
    let clock = 0;
    let runs = 0;
    const cache = createConnectionCheckCache(10_000, () => clock);
    const run = async () => { runs++; return verdict(); };
    expect((await cache.get("1:1", "jeton-a", run)).cached).toBe(false);
    clock = 5_000;
    expect((await cache.get("1:1", "jeton-a", run)).cached).toBe(true);
    expect(runs).toBe(1);
    expect((await cache.get("1:1", "jeton-b", run)).cached).toBe(false); // jeton remplacé : le résultat précédent ne vaut plus
    expect(runs).toBe(2);
    clock = 20_000;
    expect((await cache.get("1:1", "jeton-a", run)).cached).toBe(false); // mémoire expirée
    expect(runs).toBe(3);
  });

  it("deux personnes ne partagent pas leurs résultats, et deux demandes simultanées partagent un seul test", async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = createConnectionCheckCache(10_000, () => 0);
    const run = async () => { runs++; await gate; return verdict(); };
    const a = cache.get("1:1", "meme-jeton", run);
    const b = cache.get("1:1", "meme-jeton", run);
    const other = cache.get("1:2", "meme-jeton", run);
    release();
    const [ra, rb, ro] = await Promise.all([a, b, other]);
    expect(runs).toBe(2); // une fois pour 1:1 (partagée), une fois pour 1:2
    expect(ra.cached).toBe(false);
    expect(rb.cached).toBe(true);
    expect(ro.cached).toBe(false);
  });
});
