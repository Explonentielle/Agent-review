import type { AuditRepo, NewAuditEntry } from "../db/audit.js";
import { errorMessage, log } from "../logger.js";
import type { RepoWorkspace } from "../review/workspace.js";
import type { ForgeConnector } from "./types.js";

/** Ce qu'on note d'une écriture : action, cible et précisions utiles (jamais le texte d'un commentaire ni un jeton). */
type Description = Omit<NewAuditEntry, "source" | "error">;

/** Méthodes du connecteur qui écrivent sur la forge, et comment les décrire. */
const CONNECTOR_WRITES: Record<string, (args: unknown[], result: unknown) => Description> = {
  addTicketLabels: ([projectId, iid, labels]) => ({ action: "ticket_labels", target: `${projectId}/${iid}`, detail: { labels } }),
  createChangeRequest: ([projectId, input], result) => {
    const request = input as { sourceBranch: string; targetBranch: string; title: string };
    const created = result as { iid?: number; url?: string } | undefined;
    return {
      action: "change_request_create",
      target: `${projectId}/${created?.iid ?? "?"}`,
      detail: { sourceBranch: request.sourceBranch, targetBranch: request.targetBranch, title: request.title, url: created?.url },
    };
  },
  createTicket: ([projectId, input], result) => {
    const ticket = input as { title: string; labels?: string[] };
    const created = result as { iid?: number; url?: string } | undefined;
    return { action: "ticket_create", target: `${projectId}/${created?.iid ?? "?"}`, detail: { title: ticket.title, labels: ticket.labels ?? [], url: created?.url } };
  },
  createProject: ([input], result) => {
    const project = input as { name: string; namespaceId?: string; private: boolean };
    const created = result as { path?: string; url?: string } | undefined;
    return { action: "project_create", target: created?.path ?? project.name, detail: { namespaceId: project.namespaceId ?? null, private: project.private, url: created?.url } };
  },
  commentOnChangeRequest: ([projectId, iid, body, kind]) => ({ action: "change_request_comment", target: `${projectId}/${iid}`, detail: { kind, length: String(body).length } }),
  approveChangeRequest: ([projectId, iid, headSha]) => ({ action: "change_request_approve", target: `${projectId}/${iid}`, detail: { headSha } }),
};

/**
 * Note une écriture au journal sans jamais faire échouer l'action elle-même.
 * @param audit Journal de la personne.
 * @param entry Ligne à écrire.
 * @returns Rien.
 */
async function safeRecord(audit: AuditRepo, entry: NewAuditEntry): Promise<void> {
  try {
    await audit.record(entry);
  } catch (err) {
    log.warn("audit.record_failed", { action: entry.action, error: errorMessage(err) });
  }
}

/**
 * Enveloppe un connecteur de forge : chaque écriture (label, ticket, projet, MR, commentaire, approbation) est inscrite au journal d'audit, réussie ou non,
 * puis son résultat ou son erreur est rendu tel quel. Les lectures passent sans trace.
 * @param connector Connecteur réel.
 * @param audit Journal de la personne et de son espace.
 * @returns Un connecteur qui se comporte comme l'original et laisse une trace de ses écritures.
 */
export function auditConnector(connector: ForgeConnector, audit: AuditRepo): ForgeConnector {
  return new Proxy(connector, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      const describe = CONNECTOR_WRITES[prop];
      if (!describe) return bound;
      return async (...args: unknown[]) => {
        try {
          const result = await bound(...args);
          await safeRecord(audit, { source: target.kind, ...describe(args, result) });
          return result;
        } catch (err) {
          await safeRecord(audit, { source: target.kind, ...describe(args, undefined), error: errorMessage(err) });
          throw err;
        }
      };
    },
  });
}

/**
 * Enveloppe les copies locales de dépôts d'une forge : chaque branche poussée est inscrite au journal d'audit, réussie ou non.
 * @param workspace Copies de dépôts réelles.
 * @param audit Journal de la personne et de son espace.
 * @param source Forge à laquelle appartiennent ces dépôts.
 * @returns Un objet qui se comporte comme l'original et laisse une trace des pushs.
 */
export function auditWorkspace(workspace: RepoWorkspace, audit: AuditRepo, source: string): RepoWorkspace {
  return new Proxy(workspace, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "pushBranch" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (worktree: string, branch: string) => {
        try {
          await (value as RepoWorkspace["pushBranch"]).call(target, worktree, branch);
          await safeRecord(audit, { source, action: "push_branch", target: branch });
        } catch (err) {
          await safeRecord(audit, { source, action: "push_branch", target: branch, error: errorMessage(err) });
          throw err;
        }
      };
    },
  });
}
