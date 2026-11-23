import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../logger.js";
import type { AgentRunner } from "./runner.js";

/**
 * Test réel de la connexion à Claude : une demande minimale à l'agent, sans aucun outil, dans un dossier temporaire vide, avec le même
 * exécuteur que les vraies tâches (donc les mêmes identifiants, le même conteneur et les mêmes protections d'isolation). C'est le seul
 * moyen fiable de savoir si Anthropic accepte le jeton d'abonnement ou la clé API : leur simple présence ne prouve rien.
 * Coût : un tour, quelques centimes d'équivalent API (un peu de quota d'abonnement).
 */

/** Ce que le test a constaté. `refused` : Anthropic refuse l'identifiant ; `missing` : aucun identifiant ou exécuteur impossible ; `error` : autre échec. */
export type ConnectionKind = "ok" | "refused" | "missing" | "error";

export interface ConnectionCheck {
  ok: boolean;
  kind: ConnectionKind;
  /** Connexion testée : celle des réglages de la personne. */
  mode: "subscription" | "api";
  /** Phrase lisible telle quelle par la personne (jamais un secret). */
  detail: string;
  /** Instant du test (ms depuis 1970). */
  checkedAt: number;
}

export interface ConnectionCheckInput {
  /** Crée l'exécuteur de la personne ; peut lever (identifiant absent, image non autorisée). */
  makeRunner: () => AgentRunner;
  mode: ConnectionCheck["mode"];
  /** Modèle des reviews de la personne : c'est celui que les agents utiliseront. */
  model: string;
  now?: () => number;
}

/** Erreurs que renvoient la CLI et l'API quand l'identifiant est refusé (jeton ou clé invalide, expiré, révoqué ou tronqué). */
const REFUSED = /\b401\b|failed to authenticate|invalid bearer|invalid x-api-key|invalid api key|authentication_error|oauth token (has )?expired|please run \/login/i;

const MAX_DETAIL = 300;

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

/**
 * Lance le test.
 * @param input Exécuteur, mode de connexion et modèle.
 * @returns Le constat ; ne lève jamais (une erreur devient un constat `error` ou `missing`).
 */
export async function checkClaudeConnection(input: ConnectionCheckInput): Promise<ConnectionCheck> {
  const now = input.now ?? Date.now;
  const done = (kind: ConnectionKind, detail: string): ConnectionCheck => ({ ok: kind === "ok", kind, mode: input.mode, detail, checkedAt: now() });
  const label = input.mode === "api" ? "clé API" : "jeton d'abonnement";

  let runner: AgentRunner;
  try {
    runner = input.makeRunner();
  } catch (err) {
    return done("missing", errorMessage(err).slice(0, MAX_DETAIL));
  }

  const cwd = await mkdtemp(path.join(os.tmpdir(), "claude-check-"));
  try {
    await runner.run({
      cwd,
      systemPrompt: "Tu es un contrôle de connexion. Réponds uniquement par l'objet JSON demandé.",
      prompt: "Réponds avec ok = true.",
      outputSchema: SCHEMA,
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      model: input.model,
      effort: "low",
      maxTurns: 3,
      timeoutMs: 90_000,
      persistSession: false,
      stream: false,
    });
    return done("ok", `Anthropic accepte la connexion (${label}).`);
  } catch (err) {
    const message = errorMessage(err);
    if (REFUSED.test(message)) {
      return done("refused", input.mode === "api"
        ? "Anthropic refuse la clé API (401) : clé incomplète, désactivée ou supprimée. Recopie-la en entier depuis la console Anthropic."
        : "Anthropic refuse le jeton d'abonnement (401) : jeton incomplet, expiré ou révoqué. Relance « claude setup-token » sur ton poste, copie le jeton en entier (il passe sur plusieurs lignes) et colle-le ici.");
    }
    return done("error", `Le test a échoué avant de savoir si le ${label} est accepté : ${message.slice(0, MAX_DETAIL)}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Mémoire courte des tests, par personne : un clic répété ou un test en cours ne relance pas l'agent (il consomme du quota).
 * La clé inclut une empreinte de l'identifiant testé : remplacer le jeton rend le résultat précédent inutilisable tout de suite.
 */
export function createConnectionCheckCache(ttlMs = 10_000, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; result: ConnectionCheck | null; running: Promise<ConnectionCheck> | null }>();
  return {
    /**
     * @param person Clé de la personne (espace et utilisateur).
     * @param credential Identifiant testé (jeton ou clé) : seule son empreinte sert de clé, il n'est ni gardé ni journalisé.
     * @param run Test à lancer si rien de récent ne sert.
     * @returns Le constat, et `cached` s'il vient de la mémoire.
     */
    async get(person: string, credential: string, run: () => Promise<ConnectionCheck>): Promise<{ check: ConnectionCheck; cached: boolean }> {
      for (const [k, e] of entries) if (!e.running && now() - e.at >= ttlMs) entries.delete(k); // la mémoire ne grossit pas
      const key = `${person}|${createHash("sha256").update(credential).digest("hex").slice(0, 16)}`;
      const entry = entries.get(key);
      if (entry?.running) return { check: await entry.running, cached: true };
      if (entry?.result && now() - entry.at < ttlMs) return { check: entry.result, cached: true };
      const running = run();
      entries.set(key, { at: now(), result: entry?.result ?? null, running });
      try {
        const check = await running;
        entries.set(key, { at: now(), result: check, running: null });
        return { check, cached: false };
      } catch (err) {
        entries.delete(key);
        throw err;
      }
    },
  };
}
