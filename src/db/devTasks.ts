import { DEFAULT_FORGE } from "../connectors/forges.js";
import type { ForgeKind } from "../connectors/types.js";
import type { Db } from "./db.js";

export type DevTaskStatus =
  | "queued" // en attente de l'agent
  | "running" // l'agent travaille
  | "mr_created" // branche poussée + MR Draft créée : à contrôler
  | "mr_updated" // reprise : nouveau commit poussé sur la branche de la MR existante
  | "blocked" // l'agent a besoin d'infos (ticket ambigu), rien n'est poussé
  | "error"
  | "cancelled";

export interface DevTaskRow {
  id: number;
  /** Espace auquel appartient la tâche. */
  workspace_id: number;
  /** Personne qui a lancé la tâche ; null pour une tâche d'avant les quotas. */
  user_id: number | null;
  /** Forge d'où vient le ticket. */
  source: ForgeKind;
  project_id: number;
  project_path: string;
  issue_iid: number;
  issue_title: string;
  issue_url: string;
  extra_instructions: string | null;
  branch: string | null;
  base_branch: string | null;
  target_branch: string | null;
  worktree_path: string | null;
  session_id: string | null;
  status: DevTaskStatus;
  result_json: string | null;
  mr_iid: number | null;
  mr_url: string | null;
  files_changed: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  error: string | null;
  /** new = ticket traité depuis zéro ; followup = reprise de la MR d'une tâche précédente. */
  mode: "new" | "followup";
  /** Tâche reprise (mode followup). */
  parent_id: number | null;
  created_at: string;
  updated_at: string;
}

/** Ce qu'une reprise hérite de la tâche qui a créé la MR. */
export interface FollowupOrigin {
  parentId: number;
  branch: string;
  baseBranch: string | null;
  targetBranch: string | null;
  mrIid: number;
  mrUrl: string;
}

export interface DevTaskEvent {
  id: number;
  task_id: number;
  kind: "step" | "text" | "tool" | "error";
  text: string;
  created_at: string;
}

type UpdatableField =
  | "branch"
  | "base_branch"
  | "target_branch"
  | "worktree_path"
  | "session_id"
  | "status"
  | "result_json"
  | "mr_iid"
  | "mr_url"
  | "files_changed"
  | "cost_usd"
  | "num_turns"
  | "error";

export type DevTaskRepo = ReturnType<typeof createDevTaskRepo>;

const ACTIVE = "('queued', 'running')";

/**
 * Tâches de dev d'UN espace : toute requête est limitée à `workspaceId`, une tâche d'un autre espace est introuvable
 * (lecture, modification, journal d'événements). Aucune méthode ne permet de sortir de l'espace.
 * @param db Base de données.
 * @param workspaceId Espace auquel le dépôt est lié.
 * @param userId Personne servie par ce dépôt : elle est inscrite comme propriétaire des tâches créées par lui (pour compter sa consommation).
 * @returns Les opérations sur les tâches de cet espace.
 */
export function createDevTaskRepo(db: Db, workspaceId: number, userId: number | null = null) {
  return {
    /**
     * Crée une tâche de dev dans l'espace.
     * @param t Ticket traité, consignes, et origine si c'est la reprise d'une MR.
     * @returns L'id de la tâche créée.
     * @throws Error Si la tâche d'origine d'une reprise n'est pas dans l'espace.
     */
    async insert(t: {
      /** Forge d'où vient le ticket (GitLab par défaut). */
      source?: ForgeKind;
      projectId: number;
      projectPath: string;
      issueIid: number;
      issueTitle: string;
      issueUrl: string;
      extraInstructions: string | null;
      followup?: FollowupOrigin;
    }): Promise<number> {
      const f = t.followup;
      if (f && !(await db.get("SELECT 1 AS found FROM dev_tasks WHERE id = ? AND workspace_id = ?", [f.parentId, workspaceId]))) {
        throw new Error(`Tâche d'origine ${f.parentId} introuvable dans cet espace`);
      }
      const row = await db.get<{ id: number }>(
        `INSERT INTO dev_tasks (workspace_id, user_id, source, project_id, project_path, issue_iid, issue_title, issue_url, extra_instructions,
                                mode, parent_id, branch, base_branch, target_branch, mr_iid, mr_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [
          workspaceId, userId, t.source ?? DEFAULT_FORGE, t.projectId, t.projectPath, t.issueIid, t.issueTitle, t.issueUrl, t.extraInstructions,
          f ? "followup" : "new", f?.parentId ?? null, f?.branch ?? null, f?.baseBranch ?? null,
          f?.targetBranch ?? null, f?.mrIid ?? null, f?.mrUrl ?? null,
        ],
      );
      return row!.id;
    },

    /**
     * Lit une tâche de l'espace.
     * @param id Identifiant de la tâche.
     * @returns La tâche, ou undefined si elle n'existe pas dans cet espace.
     */
    get(id: number): Promise<DevTaskRow | undefined> {
      return db.get<DevTaskRow>("SELECT * FROM dev_tasks WHERE id = ? AND workspace_id = ?", [id, workspaceId]);
    },

    /**
     * Tâches de l'espace, les plus récentes d'abord.
     * @param limit Nombre maximum de tâches.
     * @returns Les tâches.
     */
    list(limit = 100): Promise<DevTaskRow[]> {
      return db.all<DevTaskRow>("SELECT * FROM dev_tasks WHERE workspace_id = ? ORDER BY id DESC LIMIT ?", [workspaceId, limit]);
    },

    /**
     * Tâche en cours ou en attente pour ce ticket (empêche de lancer deux agents dessus).
     * @param source Forge du ticket.
     * @param projectId Identifiant du projet chez la forge.
     * @param issueIid Numéro du ticket.
     * @returns La tâche active de l'espace, ou undefined.
     */
    findActive(source: ForgeKind, projectId: number, issueIid: number): Promise<DevTaskRow | undefined> {
      return db.get<DevTaskRow>(`SELECT * FROM dev_tasks WHERE workspace_id = ? AND source = ? AND project_id = ? AND issue_iid = ? AND status IN ${ACTIVE} LIMIT 1`, [
        workspaceId,
        source,
        projectId,
        issueIid,
      ]);
    },

    /**
     * La tâche de l'agent dev la plus récente qui a ouvert (ou repris) cette demande de fusion : c'est le lien exact entre une MR et son ticket.
     * @param source Forge de la demande.
     * @param projectId Projet chez la forge.
     * @param mrIid Numéro de la demande.
     * @returns La tâche, ou undefined si cette MR n'a pas été faite par l'agent dev de cet espace.
     */
    findByMergeRequest(source: ForgeKind, projectId: number, mrIid: number): Promise<DevTaskRow | undefined> {
      return db.get<DevTaskRow>("SELECT * FROM dev_tasks WHERE workspace_id = ? AND source = ? AND project_id = ? AND mr_iid = ? ORDER BY id DESC LIMIT 1", [workspaceId, source, projectId, mrIid]);
    },

    /**
     * La tâche la plus récente qui porte cette demande de fusion ET dont la MR est vivante (créée ou reprise avec succès) : celle dont la page propose
     * la relecture, la correction et la fusion. Une reprise échouée ou annulée ne compte pas : sa page n'a plus ces actions.
     * @param source Forge de la demande.
     * @param projectId Projet chez la forge.
     * @param mrIid Numéro de la demande.
     * @returns La tâche, ou undefined si aucune tâche de cet espace n'a une MR vivante sous ce numéro.
     */
    findPieceByMergeRequest(source: ForgeKind, projectId: number, mrIid: number): Promise<DevTaskRow | undefined> {
      return db.get<DevTaskRow>(
        "SELECT * FROM dev_tasks WHERE workspace_id = ? AND source = ? AND project_id = ? AND mr_iid = ? AND status IN ('mr_created', 'mr_updated') ORDER BY id DESC LIMIT 1",
        [workspaceId, source, projectId, mrIid],
      );
    },

    /**
     * Les tâches dont la MR a été fusionnée depuis l'outil (le journal de la tâche le note à la fusion). Une fusion faite à la main chez la
     * forge n'y figure pas : l'outil ne la voit pas.
     * @returns Les identifiants de ces tâches, dans l'espace.
     */
    async listMergedTaskIds(): Promise<number[]> {
      const rows = await db.all<{ task_id: number }>(
        "SELECT DISTINCT e.task_id AS task_id FROM dev_task_events e JOIN dev_tasks t ON t.id = e.task_id WHERE t.workspace_id = ? AND e.kind = 'step' AND e.text LIKE ?",
        [workspaceId, "MR !% fusionnée dans %"],
      );
      return rows.map((r) => Number(r.task_id));
    },

    /**
     * Tous les essais de l'agent sur un ticket, du plus ancien au plus récent.
     * @returns Les tâches de l'espace pour ce ticket.
     */
    listForIssue(source: ForgeKind, projectId: number, issueIid: number): Promise<DevTaskRow[]> {
      return db.all<DevTaskRow>("SELECT * FROM dev_tasks WHERE workspace_id = ? AND source = ? AND project_id = ? AND issue_iid = ? ORDER BY id", [workspaceId, source, projectId, issueIid]);
    },

    /**
     * Supprime une tâche de l'espace avec son journal. Une tâche en attente ou en cours ne se supprime pas : on l'arrête d'abord. Les
     * reprises qui s'y rattachaient perdent leur parent (leur propre rapport reste lisible). Rien n'est touché chez la forge.
     * @param id Tâche à supprimer.
     * @returns « deleted », « missing » (inconnue dans cet espace) ou « active » (en attente ou en cours : rien n'a été supprimé).
     */
    delete(id: number): Promise<"deleted" | "missing" | "active"> {
      return db.transaction(async (tx) => {
        const row = await tx.get<{ status: string }>("SELECT status FROM dev_tasks WHERE id = ? AND workspace_id = ?", [id, workspaceId]);
        if (!row) return "missing";
        if (row.status === "queued" || row.status === "running") return "active";
        await tx.run("DELETE FROM dev_task_events WHERE task_id IN (SELECT id FROM dev_tasks WHERE id = ? AND workspace_id = ?)", [id, workspaceId]);
        await tx.run("UPDATE dev_tasks SET parent_id = NULL WHERE parent_id = ? AND workspace_id = ?", [id, workspaceId]);
        await tx.run("DELETE FROM dev_tasks WHERE id = ? AND workspace_id = ?", [id, workspaceId]);
        return "deleted";
      });
    },

    /**
     * Dernière tâche de l'espace par ticket, pour l'affichage dans l'onglet Tickets.
     * @returns Les tâches, par clé `source#projet#ticket`.
     */
    async latestByIssue(): Promise<Map<string, DevTaskRow>> {
      const rows = await db.all<DevTaskRow>(
        "SELECT * FROM dev_tasks WHERE id IN (SELECT MAX(id) FROM dev_tasks WHERE workspace_id = ? GROUP BY source, project_id, issue_iid)",
        [workspaceId],
      );
      return new Map(rows.map((r) => [`${r.source}#${r.project_id}#${r.issue_iid}`, r]));
    },

    /**
     * Tâches de l'espace interrompues par un arrêt du process.
     * @returns Les tâches en attente ou en cours.
     */
    listInterrupted(): Promise<DevTaskRow[]> {
      return db.all<DevTaskRow>(`SELECT * FROM dev_tasks WHERE workspace_id = ? AND status IN ${ACTIVE}`, [workspaceId]);
    },

    /**
     * Met à jour certains champs d'une tâche de l'espace.
     * @param id Identifiant de la tâche.
     * @param fields Champs à modifier (ceux qui sont `undefined` sont ignorés).
     * @returns Rien (sans effet si la tâche n'est pas dans l'espace).
     */
    async update(id: number, fields: Partial<Pick<DevTaskRow, UpdatableField>>): Promise<void> {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const set = entries.map(([k]) => `${k} = ?`).join(", ");
      await db.run(`UPDATE dev_tasks SET ${set}, updated_at = ${db.sql.now} WHERE id = ? AND workspace_id = ?`, [...entries.map(([, v]) => v), id, workspaceId]);
    },

    /**
     * Ajoute un événement au journal d'une tâche de l'espace.
     * @param taskId Identifiant de la tâche.
     * @param kind Type d'événement.
     * @param text Texte (tronqué à 4000 caractères).
     * @returns Rien.
     * @throws Error Si la tâche n'est pas dans l'espace : rien n'est écrit.
     */
    async addEvent(taskId: number, kind: DevTaskEvent["kind"], text: string): Promise<void> {
      const res = await db.run(
        "INSERT INTO dev_task_events (task_id, kind, text) SELECT id, CAST(? AS TEXT), CAST(? AS TEXT) FROM dev_tasks WHERE id = ? AND workspace_id = ?",
        [kind, text.slice(0, 4000), taskId, workspaceId],
      );
      if (res.changes === 0) throw new Error(`Tâche ${taskId} introuvable dans cet espace`);
    },

    /**
     * Événements du journal d'une tâche de l'espace.
     * @param taskId Identifiant de la tâche.
     * @param afterId Ne renvoyer que les événements postérieurs à cet identifiant.
     * @returns Jusqu'à 500 événements, dans l'ordre (vide si la tâche n'est pas dans l'espace).
     */
    events(taskId: number, afterId = 0): Promise<DevTaskEvent[]> {
      return db.all<DevTaskEvent>(
        `SELECT e.* FROM dev_task_events e JOIN dev_tasks t ON t.id = e.task_id
          WHERE e.task_id = ? AND e.id > ? AND t.workspace_id = ? ORDER BY e.id LIMIT 500`,
        [taskId, afterId, workspaceId],
      );
    },
  };
}
