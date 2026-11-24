import { createRunner } from "../agent/index.js";
import { agentRunConfig } from "../claude/process.js";
import type { Ticket } from "../connectors/types.js";
import type { NewPlanItem, PlanRow } from "../db/plans.js";
import { errorMessage, log } from "../logger.js";
import { loadSystemPrompt } from "../prompts.js";
import { ScribeInputError, cleanTicket } from "../scribe/clean.js";
import { runScribe } from "../scribe/engine.js";
import { explainForgeError } from "../scribe/errors.js";
import { proposableLabels } from "../scribe/prompt.js";
import { MAX_PLAN_ITEMS, type PlanDeps } from "./deps.js";
import { buildPlanPrompt } from "./prompt.js";
import { PlanTurnSchema, planTurnJsonSchema, type PlanTurn } from "./schema.js";

/**
 * Valide les tickets proposés par l'agent avec les mêmes règles que le Scribe : un ticket invalide est écarté, les étiquettes sont limitées à celles
 * autorisées, le nombre de tickets est borné.
 * @param tickets Tickets renvoyés par l'agent.
 * @param allowedLabels Étiquettes autorisées.
 * @returns Les tickets du plan, dans l'ordre.
 */
export function cleanProposed(tickets: PlanTurn["tickets"], allowedLabels: string[]): NewPlanItem[] {
  const out: NewPlanItem[] = [];
  for (const raw of tickets.slice(0, MAX_PLAN_ITEMS)) {
    try {
      const ticket = cleanTicket(raw);
      out.push({ ...ticket, labels: ticket.labels.filter((l) => allowedLabels.includes(l)), runAt: null });
    } catch (err) {
      if (!(err instanceof ScribeInputError)) throw err;
    }
  }
  return out;
}

/**
 * Joue un tour du chat de cadrage : l'agent lit l'échange et répond par des questions, ou propose la liste de tickets. L'agent n'a aucun outil et ne
 * crée rien : le plan proposé reste en relecture (`review`) tant que la personne ne l'a pas validé. Le plan doit avoir été réservé (`acquire` ou
 * `startChat`) : il est libéré à la fin, avec le résultat du tour. Une erreur est enregistrée sur le plan, jamais levée.
 * @param deps Dépôts, forges et réglages de la personne.
 * @param plan Plan réservé, en discussion ou en relecture.
 * @returns Le message d'erreur du tour, ou null s'il s'est bien passé.
 */
export async function runChatTurn(deps: PlanDeps, plan: PlanRow): Promise<string | null> {
  let error: string | null = null;
  let costUsd: number | null = null;
  try {
    const settings = await deps.settings.get();
    const connector = deps.forges.get(plan.source).connector;
    const [project, recent, messages, current] = await Promise.all([
      connector.getProject(plan.project_id).catch((err: unknown) => {
        throw explainForgeError(plan.source, "list", err);
      }),
      connector.listProjectTickets(plan.project_id).catch((err: unknown): Ticket[] => {
        log.warn("plan.recent_tickets_failed", { planId: plan.id, error: errorMessage(err) });
        return [];
      }),
      deps.plans.messages(plan.id),
      deps.plans.items(plan.id),
    ]);
    const allowedLabels = proposableLabels(settings.workflow.todoLabels, recent);
    const systemPrompt = await loadSystemPrompt("planner", { override: "", instructions: "", project: null });
    // Quelques tours suffisent : l'agent n'a aucun outil et ne fait que rédiger
    const engine = { ...agentRunConfig(settings.review), maxTurns: 3, timeoutMs: 5 * 60_000 };
    const runner = deps.runner ?? createRunner(deps.config, settings);
    const out = await runScribe<PlanTurn>(
      {
        systemPrompt,
        prompt: buildPlanPrompt({
          kind: plan.kind,
          project: { path: project.path, description: project.description },
          recentTitles: recent.map((t) => t.title),
          allowedLabels,
          messages: messages.map((m) => ({ role: m.role, text: m.text })),
          currentTickets: current.map((i) => ({ title: i.title, description: i.description, labels: JSON.parse(i.labels) as string[] })),
        }),
        engine,
        runner,
      },
      planTurnJsonSchema,
      (v) => PlanTurnSchema.safeParse(v),
    );
    costUsd = out.costUsd;

    const proposed = out.draft.ready ? cleanProposed(out.draft.tickets, allowedLabels) : [];
    const reply = out.draft.reply.trim() || (out.draft.ready ? "Voici le plan proposé : relis-le, corrige-le, puis valide-le." : "Peux-tu préciser ta demande ?");
    await deps.plans.addMessage(plan.id, "assistant", reply);
    if (out.draft.ready) {
      if (proposed.length === 0) error = "Le plan proposé est vide ou invalide : précise ta demande pour que l'orchestrateur le refasse.";
      else if (!(await deps.plans.replaceProposed(plan.id, proposed))) error = "Le plan n'accepte plus de modification.";
    }
    log.info("plan.chat_turn", { planId: plan.id, ready: out.draft.ready, tickets: proposed.length, costUsd });
  } catch (err) {
    error = errorMessage(err);
    log.warn("plan.chat_turn_failed", { planId: plan.id, error });
  }
  // Le plan est en relecture dès qu'il a des tickets proposés, sinon la discussion continue
  const hasItems = (await deps.plans.items(plan.id)).length > 0;
  await deps.plans.release(plan.id, { status: hasItems ? "review" : "chatting", error, costUsd });
  return error;
}
