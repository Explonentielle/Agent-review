import type { ForgeKind } from "../connectors/types.js";
import type { Db } from "./db.js";

export type PlanKind = "feature" | "project";

export type PlanStatus =
  | "waiting_chat" // le chat de cadrage est planifié, il n'a pas encore commencé
  | "chatting" // le chat est ouvert : la personne et l'orchestrateur échangent
  | "review" // un plan de tickets est proposé : la personne le relit et le corrige, rien n'est créé
  | "scheduled" // plan validé, tickets créés chez la forge, exécution planifiée
  | "running" // l'orchestrateur lance les tickets un par un
  | "paused" // aucun nouveau ticket n'est lancé (celui en cours va à son terme)
  | "done" // tous les tickets sont traités
  | "failed" // un ticket a échoué : le plan s'est arrêté
  | "cancelled";

export type PlanItemStatus =
  | "proposed" // proposé par le chat ou saisi par la personne, pas encore créé chez la forge
  | "pending" // ticket créé chez la forge, en attente de son tour
  | "running" // l'agent dev travaille dessus
  | "done" // l'agent a ouvert (ou mis à jour) la MR
  | "failed" // la tâche de l'agent a échoué, a été annulée ou pose des questions
  | "skipped" // écarté par la personne : ne sera pas lancé
  | "cancelled"; // le plan a été annulé avant son tour

export interface PlanRow {
  id: number;
  workspace_id: number;
  /** Personne qui a ouvert le plan ; ses tâches comptent dans ses quotas. */
  user_id: number | null;
  source: ForgeKind;
  project_id: number;
  project_path: string;
  /** feature = une fonctionnalité ; project = le développement d'un projet complet en une seule passe. */
  kind: PlanKind;
  title: string;
  status: PlanStatus;
  /** Date de lancement du chat (UTC, `AAAA-MM-JJ HH:MM:SS`), ou null. */
  chat_at: string | null;
  /** Date de lancement de l'exécution (UTC), ou null : dès la validation. */
  run_at: string | null;
  /** 1 pendant un tour de chat ou une validation : empêche d'en lancer un deuxième en même temps. */
  busy: number;
  error: string | null;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

export interface PlanItemRow {
  id: number;
  workspace_id: number;
  plan_id: number;
  position: number;
  title: string;
  description: string;
  /** Étiquettes, en JSON (tableau de textes). */
  labels: string;
  /** Date de lancement propre à ce ticket (UTC), ou null : à son tour. */
  run_at: string | null;
  status: PlanItemStatus;
  issue_iid: number | null;
  issue_url: string | null;
  task_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanMessageRow {
  id: number;
  workspace_id: number;
  plan_id: number;
  role: "user" | "assistant";
  text: string;
  created_at: string;
}

/** Ticket proposé, tel qu'il entre dans un plan. */
export interface NewPlanItem {
  title: string;
  description: string;
  labels: string[];
  runAt: string | null;
}

type PlanFields = "title" | "chat_at" | "run_at" | "error";
type ItemFields = "position" | "title" | "description" | "labels" | "run_at" | "status" | "issue_iid" | "issue_url" | "task_id" | "error";

/** Avancement d'un plan, ticket par ticket. */
export interface PlanCounts {
  total: number;
  /** À venir : proposés ou créés, pas encore lancés. */
  upcoming: number;
  running: number;
  done: number;
  failed: number;
  /** Écartés ou annulés. */
  skipped: number;
}

export type PlanRepo = ReturnType<typeof createPlanRepo>;

/** Plans dont l'orchestrateur doit s'occuper à chaque passage. */
const ACTIVE = "('waiting_chat', 'scheduled', 'running', 'paused')";

/**
 * Avancement d'un plan d'après le nombre de tickets par statut.
 * @param byStatus Nombre de tickets par statut.
 * @returns Les compteurs d'avancement.
 */
export function summarizeCounts(byStatus: Partial<Record<PlanItemStatus, number>>): PlanCounts {
  const n = (s: PlanItemStatus) => byStatus[s] ?? 0;
  const total = Object.values(byStatus).reduce((sum, v) => sum + (v ?? 0), 0);
  return { total, upcoming: n("proposed") + n("pending"), running: n("running"), done: n("done"), failed: n("failed"), skipped: n("skipped") + n("cancelled") };
}

/**
 * Plans d'UN espace (chat de cadrage, tickets proposés, avancement) : toute requête est limitée à `workspaceId`, un plan d'un autre espace est
 * introuvable. Aucune méthode ne permet de sortir de l'espace.
 * @param db Base de données.
 * @param workspaceId Espace auquel le dépôt est lié.
 * @param userId Personne servie par ce dépôt : elle est inscrite comme propriétaire des plans créés par lui.
 * @returns Les opérations sur les plans de cet espace.
 */
export function createPlanRepo(db: Db, workspaceId: number, userId: number | null = null) {
  const placeholders = (values: readonly unknown[]): string => values.map(() => "?").join(", ");

  const repo = {
    /**
     * Ouvre un plan avec le premier message de la personne.
     * @param p Projet visé, nature du plan, premier message, et date de lancement du chat (null : le chat commence tout de suite).
     * @returns L'id du plan.
     */
    insert(p: { source: ForgeKind; projectId: number; projectPath: string; kind: PlanKind; title: string; firstMessage: string; chatAt: string | null }): Promise<number> {
      return db.transaction(async (tx) => {
        const row = await tx.get<{ id: number }>(
          `INSERT INTO plans (workspace_id, user_id, source, project_id, project_path, kind, title, status, chat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id`,
          [workspaceId, userId, p.source, p.projectId, p.projectPath, p.kind, p.title, p.chatAt ? "waiting_chat" : "chatting", p.chatAt],
        );
        await tx.run("INSERT INTO plan_messages (workspace_id, plan_id, role, text) VALUES (?, ?, 'user', ?)", [workspaceId, row!.id, p.firstMessage]);
        return row!.id;
      });
    },

    /**
     * Lit un plan de l'espace.
     * @param id Identifiant du plan.
     * @returns Le plan, ou undefined s'il n'existe pas dans cet espace.
     */
    get(id: number): Promise<PlanRow | undefined> {
      return db.get<PlanRow>("SELECT * FROM plans WHERE id = ? AND workspace_id = ?", [id, workspaceId]);
    },

    /**
     * Plans de l'espace, les plus récents d'abord.
     * @param limit Nombre maximum de plans.
     * @returns Les plans.
     */
    list(limit = 50): Promise<PlanRow[]> {
      return db.all<PlanRow>("SELECT * FROM plans WHERE workspace_id = ? ORDER BY id DESC LIMIT ?", [workspaceId, limit]);
    },

    /**
     * Plans que l'orchestrateur doit faire avancer (chat planifié, exécution planifiée, en cours, en pause). Seuls ceux de la personne servie par ce
     * dépôt : un plan s'exécute avec les connexions et les quotas de celle qui l'a ouvert, jamais avec ceux d'un autre membre de l'espace.
     * @returns Les plans, du plus ancien au plus récent.
     */
    listActive(): Promise<PlanRow[]> {
      const own = userId === null ? "" : " AND user_id = ?";
      return db.all<PlanRow>(`SELECT * FROM plans WHERE workspace_id = ?${own} AND status IN ${ACTIVE} ORDER BY id`, userId === null ? [workspaceId] : [workspaceId, userId]);
    },

    /**
     * Avancement de tous les plans de l'espace en une requête.
     * @returns Les compteurs, par identifiant de plan.
     */
    async countsByPlan(): Promise<Map<number, PlanCounts>> {
      const rows = await db.all<{ plan_id: number; status: PlanItemStatus; n: number }>(
        "SELECT plan_id, status, CAST(COUNT(*) AS INTEGER) AS n FROM plan_items WHERE workspace_id = ? GROUP BY plan_id, status",
        [workspaceId],
      );
      const grouped = new Map<number, Partial<Record<PlanItemStatus, number>>>();
      for (const r of rows) grouped.set(Number(r.plan_id), { ...grouped.get(Number(r.plan_id)), [r.status]: Number(r.n) });
      return new Map([...grouped].map(([id, byStatus]): [number, PlanCounts] => [id, summarizeCounts(byStatus)]));
    },

    /**
     * Échanges du chat d'un plan de l'espace.
     * @param planId Identifiant du plan.
     * @returns Jusqu'à 200 messages, dans l'ordre (vide si le plan n'est pas dans l'espace).
     */
    messages(planId: number): Promise<PlanMessageRow[]> {
      return db.all<PlanMessageRow>("SELECT * FROM plan_messages WHERE plan_id = ? AND workspace_id = ? ORDER BY id LIMIT 200", [planId, workspaceId]);
    },

    /**
     * Ajoute un message au chat d'un plan de l'espace.
     * @param planId Identifiant du plan.
     * @param role Auteur du message.
     * @param text Texte (tronqué à 8000 caractères).
     * @returns Rien.
     * @throws Error Si le plan n'est pas dans l'espace : rien n'est écrit.
     */
    async addMessage(planId: number, role: PlanMessageRow["role"], text: string): Promise<void> {
      const res = await db.run(
        "INSERT INTO plan_messages (workspace_id, plan_id, role, text) SELECT workspace_id, id, CAST(? AS TEXT), CAST(? AS TEXT) FROM plans WHERE id = ? AND workspace_id = ?",
        [role, text.slice(0, 8000), planId, workspaceId],
      );
      if (res.changes === 0) throw new Error(`Plan ${planId} introuvable dans cet espace`);
    },

    /**
     * Tickets d'un plan de l'espace, dans l'ordre d'exécution.
     * @param planId Identifiant du plan.
     * @returns Les tickets (vide si le plan n'est pas dans l'espace).
     */
    items(planId: number): Promise<PlanItemRow[]> {
      return db.all<PlanItemRow>("SELECT * FROM plan_items WHERE plan_id = ? AND workspace_id = ? ORDER BY position, id", [planId, workspaceId]);
    },

    /**
     * Remplace la liste des tickets proposés d'un plan. Refusé dès qu'un ticket a quitté l'état « proposé » (créé chez la forge) ou si le plan
     * n'est plus en discussion ou en relecture : une liste déjà créée ne se réécrit pas.
     * @param planId Identifiant du plan.
     * @param items Tickets, dans l'ordre voulu.
     * @returns Vrai si la liste a été remplacée, faux si le plan ne l'accepte pas (rien n'est modifié).
     */
    replaceProposed(planId: number, items: NewPlanItem[]): Promise<boolean> {
      return db.transaction(async (tx) => {
        const plan = await tx.get<{ status: PlanStatus }>("SELECT status FROM plans WHERE id = ? AND workspace_id = ?", [planId, workspaceId]);
        if (!plan || (plan.status !== "chatting" && plan.status !== "review")) return false;
        const started = await tx.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM plan_items WHERE plan_id = ? AND workspace_id = ? AND status <> 'proposed'", [planId, workspaceId]);
        if (Number(started!.n) > 0) return false;
        await tx.run("DELETE FROM plan_items WHERE plan_id = ? AND workspace_id = ?", [planId, workspaceId]);
        if (items.length > 0) {
          await tx.run(
            `INSERT INTO plan_items (workspace_id, plan_id, position, title, description, labels, run_at, status) VALUES ${items.map(() => "(?, ?, ?, ?, ?, ?, ?, 'proposed')").join(", ")}`,
            items.flatMap((item, i) => [workspaceId, planId, i + 1, item.title, item.description, JSON.stringify(item.labels), item.runAt]),
          );
        }
        return true;
      });
    },

    /**
     * Modifie certains champs d'un ticket de plan de l'espace.
     * @param itemId Identifiant du ticket.
     * @param fields Champs à modifier (ceux qui sont `undefined` sont ignorés).
     * @param onlyFrom Si présent, la modification n'a lieu que si le ticket a l'un de ces statuts (transition atomique).
     * @returns Vrai si une ligne a été modifiée.
     */
    async updateItem(itemId: number, fields: Partial<Pick<PlanItemRow, ItemFields>>, onlyFrom?: PlanItemStatus[]): Promise<boolean> {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return false;
      const set = entries.map(([k]) => `${k} = ?`).join(", ");
      const guard = onlyFrom ? ` AND status IN (${placeholders(onlyFrom)})` : "";
      const res = await db.run(`UPDATE plan_items SET ${set}, updated_at = ${db.sql.now} WHERE id = ? AND workspace_id = ?${guard}`, [...entries.map(([, v]) => v), itemId, workspaceId, ...(onlyFrom ?? [])]);
      return res.changes > 0;
    },

    /**
     * Prend un ticket en attente pour le lancer : de deux appels simultanés, un seul l'obtient.
     * @param itemId Identifiant du ticket.
     * @returns Vrai si ce ticket était en attente et passe en cours.
     */
    claimItem(itemId: number): Promise<boolean> {
      return repo.updateItem(itemId, { status: "running" }, ["pending"]);
    },

    /**
     * Réordonne les tickets encore en attente d'un plan : ils reprennent, dans le nouvel ordre, les places qu'ils occupaient. Ceux qui ont déjà
     * démarré ne bougent pas.
     * @param planId Identifiant du plan.
     * @param order Identifiants de TOUS les tickets en attente, dans l'ordre voulu.
     * @returns Vrai si l'ordre a été appliqué, faux si la liste ne correspond pas aux tickets en attente (rien n'est modifié).
     */
    async reorderPending(planId: number, order: number[]): Promise<boolean> {
      const pending = (await repo.items(planId)).filter((i) => i.status === "pending");
      if (pending.length !== order.length || new Set(order).size !== order.length || !order.every((id) => pending.some((i) => i.id === id))) return false;
      if (order.length === 0) return true;
      const slots = pending.map((i) => i.position).sort((a, b) => a - b);
      const cases = order.map(() => "WHEN ? THEN CAST(? AS INTEGER)").join(" ");
      const res = await db.run(
        `UPDATE plan_items SET position = CASE id ${cases} END, updated_at = ${db.sql.now}
          WHERE plan_id = ? AND workspace_id = ? AND status = 'pending' AND id IN (${placeholders(order)})`,
        [...order.flatMap((id, i) => [id, slots[i]]), planId, workspaceId, ...order],
      );
      return res.changes === order.length;
    },

    /**
     * Annule les tickets d'un plan qui n'ont pas démarré (proposés ou en attente).
     * @param planId Identifiant du plan.
     * @returns Rien.
     */
    async cancelNotStarted(planId: number): Promise<void> {
      await db.run(`UPDATE plan_items SET status = 'cancelled', updated_at = ${db.sql.now} WHERE plan_id = ? AND workspace_id = ? AND status IN ('proposed', 'pending')`, [planId, workspaceId]);
    },

    /**
     * Réserve un plan pour un tour de chat ou une validation : de deux demandes simultanées, une seule l'obtient.
     * @param planId Identifiant du plan.
     * @param statuses Statuts dans lesquels la réservation est permise.
     * @returns Vrai si le plan était libre et dans un de ces statuts.
     */
    async acquire(planId: number, statuses: PlanStatus[]): Promise<boolean> {
      const res = await db.run(`UPDATE plans SET busy = 1, updated_at = ${db.sql.now} WHERE id = ? AND workspace_id = ? AND busy = 0 AND status IN (${placeholders(statuses)})`, [planId, workspaceId, ...statuses]);
      return res.changes > 0;
    },

    /**
     * Démarre un chat planifié dont l'heure est venue, et le réserve.
     * @param planId Identifiant du plan.
     * @returns Vrai si le plan attendait son chat et le démarre maintenant.
     */
    async startChat(planId: number): Promise<boolean> {
      const res = await db.run(
        `UPDATE plans SET status = 'chatting', busy = 1, chat_at = NULL, updated_at = ${db.sql.now} WHERE id = ? AND workspace_id = ? AND status = 'waiting_chat' AND busy = 0`,
        [planId, workspaceId],
      );
      return res.changes > 0;
    },

    /**
     * Libère un plan réservé et fixe son statut. La consommation du tour s'ajoute à celle du plan. Un plan annulé pendant le tour reste annulé :
     * le statut n'est appliqué que s'il était encore en discussion ou en relecture.
     * @param planId Identifiant du plan.
     * @param result Nouveau statut, erreur éventuelle (null l'efface), consommation du tour.
     * @returns Vrai si le statut a été appliqué, faux si le plan avait été annulé entre-temps.
     */
    async release(planId: number, result: { status: PlanStatus; error: string | null; costUsd?: number | null }): Promise<boolean> {
      const res = await db.run(
        `UPDATE plans SET busy = 0, status = ?, error = ?, cost_usd = COALESCE(cost_usd, 0) + ?, updated_at = ${db.sql.now}
          WHERE id = ? AND workspace_id = ? AND status IN ('chatting', 'review')`,
        [result.status, result.error, result.costUsd ?? 0, planId, workspaceId],
      );
      return res.changes > 0;
    },

    /**
     * Change le statut d'un plan, seulement s'il a l'un des statuts de départ (transition atomique).
     * @param planId Identifiant du plan.
     * @param from Statuts de départ permis.
     * @param to Nouveau statut.
     * @param fields Autres champs à modifier en même temps.
     * @returns Vrai si le plan avait un de ces statuts et a changé.
     */
    async transition(planId: number, from: PlanStatus[], to: PlanStatus, fields: Partial<Pick<PlanRow, PlanFields>> = {}): Promise<boolean> {
      const entries = Object.entries({ ...fields, status: to }).filter(([, v]) => v !== undefined);
      const set = entries.map(([k]) => `${k} = ?`).join(", ");
      const res = await db.run(`UPDATE plans SET ${set}, updated_at = ${db.sql.now} WHERE id = ? AND workspace_id = ? AND status IN (${placeholders(from)})`, [
        ...entries.map(([, v]) => v),
        planId,
        workspaceId,
        ...from,
      ]);
      return res.changes > 0;
    },

    /**
     * Modifie certains champs d'un plan de l'espace.
     * @param planId Identifiant du plan.
     * @param fields Champs à modifier (ceux qui sont `undefined` sont ignorés).
     * @returns Rien (sans effet si le plan n'est pas dans l'espace).
     */
    async update(planId: number, fields: Partial<Pick<PlanRow, PlanFields>>): Promise<void> {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const set = entries.map(([k]) => `${k} = ?`).join(", ");
      await db.run(`UPDATE plans SET ${set}, updated_at = ${db.sql.now} WHERE id = ? AND workspace_id = ?`, [...entries.map(([, v]) => v), planId, workspaceId]);
    },

    /**
     * Libère les plans que l'arrêt de l'outil a laissés réservés (tour de chat ou validation coupés en route).
     * @returns Le nombre de plans libérés.
     */
    async recoverInterrupted(): Promise<number> {
      const res = await db.run(`UPDATE plans SET busy = 0, error = ?, updated_at = ${db.sql.now} WHERE workspace_id = ? AND busy = 1`, ["Interrompu par un redémarrage de l'outil : relance l'action.", workspaceId]);
      return res.changes;
    },
  };
  return repo;
}
