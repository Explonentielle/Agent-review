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

export function createDevTaskRepo(db: Db) {
  return {
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
      const row = await db.get<{ id: number }>(
        `INSERT INTO dev_tasks (source, project_id, project_path, issue_iid, issue_title, issue_url, extra_instructions,
                                mode, parent_id, branch, base_branch, target_branch, mr_iid, mr_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [
          t.source ?? DEFAULT_FORGE, t.projectId, t.projectPath, t.issueIid, t.issueTitle, t.issueUrl, t.extraInstructions,
          f ? "followup" : "new", f?.parentId ?? null, f?.branch ?? null, f?.baseBranch ?? null,
          f?.targetBranch ?? null, f?.mrIid ?? null, f?.mrUrl ?? null,
        ],
      );
      return row!.id;
    },

    get(id: number): Promise<DevTaskRow | undefined> {
      return db.get<DevTaskRow>("SELECT * FROM dev_tasks WHERE id = ?", [id]);
    },

    list(limit = 100): Promise<DevTaskRow[]> {
      return db.all<DevTaskRow>("SELECT * FROM dev_tasks ORDER BY id DESC LIMIT ?", [limit]);
    },

    /** Tâche en cours ou en attente pour ce ticket (empêche de lancer deux agents dessus). */
    findActive(source: ForgeKind, projectId: number, issueIid: number): Promise<DevTaskRow | undefined> {
      return db.get<DevTaskRow>(`SELECT * FROM dev_tasks WHERE source = ? AND project_id = ? AND issue_iid = ? AND status IN ${ACTIVE} LIMIT 1`, [source, projectId, issueIid]);
    },

    /** Dernière tâche par ticket, pour l'affichage dans l'onglet Tickets. Clé : `source#projet#ticket`. */
    async latestByIssue(): Promise<Map<string, DevTaskRow>> {
      const rows = await db.all<DevTaskRow>("SELECT * FROM dev_tasks WHERE id IN (SELECT MAX(id) FROM dev_tasks GROUP BY source, project_id, issue_iid)");
      return new Map(rows.map((r) => [`${r.source}#${r.project_id}#${r.issue_iid}`, r]));
    },

    listInterrupted(): Promise<DevTaskRow[]> {
      return db.all<DevTaskRow>(`SELECT * FROM dev_tasks WHERE status IN ${ACTIVE}`);
    },

    async update(id: number, fields: Partial<Pick<DevTaskRow, UpdatableField>>): Promise<void> {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const set = entries.map(([k]) => `${k} = ?`).join(", ");
      await db.run(`UPDATE dev_tasks SET ${set}, updated_at = ${db.sql.now} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
    },

    async addEvent(taskId: number, kind: DevTaskEvent["kind"], text: string): Promise<void> {
      await db.run("INSERT INTO dev_task_events (task_id, kind, text) VALUES (?, ?, ?)", [taskId, kind, text.slice(0, 4000)]);
    },

    events(taskId: number, afterId = 0): Promise<DevTaskEvent[]> {
      return db.all<DevTaskEvent>("SELECT * FROM dev_task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 500", [taskId, afterId]);
    },
  };
}
