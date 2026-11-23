import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRunner } from "../agent/runner.js";
import type { AgentRunConfig } from "../claude/process.js";
import { ProjectDraftSchema, TicketDraftSchema, projectDraftJsonSchema, ticketDraftJsonSchema, type ProjectDraft, type TicketDraft } from "./schema.js";

export interface ScribeEngineInput {
  systemPrompt: string;
  prompt: string;
  engine: AgentRunConfig;
  runner: AgentRunner;
}

export interface ScribeOutput<T> {
  draft: T;
  costUsd: number | null;
  numTurns: number | null;
}

/**
 * Lance l'agent Scribe. Il n'a AUCUN outil (ni lecture, ni commande, ni réseau) et travaille dans un dossier temporaire vide : il ne
 * peut rien lire ni rien écrire, il ne renvoie que son brouillon. Même exécuteur que les autres agents, donc mêmes protections
 * d'isolation (`src/agent/cliRunner.ts`). Partagé avec l'orchestrateur de plans (`src/orchestrator/chat.ts`), qui a les mêmes garanties.
 */
export async function runScribe<T>(input: ScribeEngineInput, schema: Record<string, unknown>, parse: (value: unknown) => { success: true; data: T } | { success: false; error: { message: string } }): Promise<ScribeOutput<T>> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "scribe-"));
  try {
    const out = await input.runner.run({
      cwd,
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
      outputSchema: schema,
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      ...input.engine,
      persistSession: false,
      stream: false,
    });
    const parsed = parse(out.structured);
    if (!parsed.success) throw new Error(`Le Scribe a renvoyé un brouillon invalide : ${parsed.error.message}`);
    return { draft: parsed.data, costUsd: out.costUsd, numTurns: out.numTurns };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Fait rédiger un ticket par l'agent.
 * @param input Prompts, réglages du moteur et exécuteur.
 * @returns Le brouillon de ticket et la consommation estimée.
 */
export function draftTicket(input: ScribeEngineInput): Promise<ScribeOutput<TicketDraft>> {
  return runScribe(input, ticketDraftJsonSchema, (v) => TicketDraftSchema.safeParse(v));
}

/**
 * Fait rédiger un projet et ses premiers tickets par l'agent.
 * @param input Prompts, réglages du moteur et exécuteur.
 * @returns Le brouillon de projet et la consommation estimée.
 */
export function draftProject(input: ScribeEngineInput): Promise<ScribeOutput<ProjectDraft>> {
  return runScribe(input, projectDraftJsonSchema, (v) => ProjectDraftSchema.safeParse(v));
}
