import type { Db } from "./index.js";

export type DevTaskStatus =
  | "queued" // en attente de l'agent
  | "running" // l'agent travaille
  | "mr_created" // branche poussée + MR Draft créée : à contrôler
  | "blocked" // l'agent a besoin d'infos (ticket ambigu), rien n'est poussé
  | "error"
  | "cancelled";

export interface DevTaskRow {
  id: number;
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
  created_at: string;
  updated_at: string;
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
    insert(t: { projectId: number; projectPath: string; issueIid: number; issueTitle: string; issueUrl: string; extraInstructions: string | null }): number {
      const res = db
        .prepare(
          `INSERT INTO dev_tasks (project_id, project_path, issue_iid, issue_title, issue_url, extra_instructions)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(t.projectId, t.projectPath, t.issueIid, t.issueTitle, t.issueUrl, t.extraInstructions);
      return Number(res.lastInsertRowid);
    },

    get(id: number): DevTaskRow | undefined {
      return db.prepare("SELECT * FROM dev_tasks WHERE id = ?").get(id) as DevTaskRow | undefined;
    },

    list(limit = 100): DevTaskRow[] {
      return db.prepare("SELECT * FROM dev_tasks ORDER BY id DESC LIMIT ?").all(limit) as unknown as DevTaskRow[];
    },

    /** Tâche en cours ou en attente pour ce ticket (empêche de lancer deux agents dessus). */
    findActive(projectId: number, issueIid: number): DevTaskRow | undefined {
      return db
        .prepare(`SELECT * FROM dev_tasks WHERE project_id = ? AND issue_iid = ? AND status IN ${ACTIVE} LIMIT 1`)
        .get(projectId, issueIid) as DevTaskRow | undefined;
    },

    /** Dernière tâche par ticket, pour l'affichage dans l'onglet Tickets. */
    latestByIssue(): Map<string, DevTaskRow> {
      const rows = db
        .prepare("SELECT * FROM dev_tasks WHERE id IN (SELECT MAX(id) FROM dev_tasks GROUP BY project_id, issue_iid)")
        .all() as unknown as DevTaskRow[];
      return new Map(rows.map((r) => [`${r.project_id}#${r.issue_iid}`, r]));
    },

    listInterrupted(): DevTaskRow[] {
      return db.prepare(`SELECT * FROM dev_tasks WHERE status IN ${ACTIVE}`).all() as unknown as DevTaskRow[];
    },

    update(id: number, fields: Partial<Pick<DevTaskRow, UpdatableField>>): void {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const set = entries.map(([k]) => `${k} = ?`).join(", ");
      db.prepare(`UPDATE dev_tasks SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(
        ...entries.map(([, v]) => v as string | number | null),
        id,
      );
    },

    addEvent(taskId: number, kind: DevTaskEvent["kind"], text: string): void {
      db.prepare("INSERT INTO dev_task_events (task_id, kind, text) VALUES (?, ?, ?)").run(taskId, kind, text.slice(0, 4000));
    },

    events(taskId: number, afterId = 0): DevTaskEvent[] {
      return db
        .prepare("SELECT * FROM dev_task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 500")
        .all(taskId, afterId) as unknown as DevTaskEvent[];
    },
  };
}
