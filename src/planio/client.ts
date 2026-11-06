/**
 * Client Planio (API REST Redmine) : PHASE 3, pas encore branché sur le pipeline.
 *
 * Le client de timelog (app/Planio/Client.php) ne couvre que l'export des temps passés ;
 * le support a besoin des tickets, de leur historique (journals) et de l'ajout de notes.
 * Auth : clé API perso (Mon compte > Clé d'accès API), header X-Redmine-API-Key.
 */

export interface PlanioIssue {
  id: number;
  subject: string;
  description: string;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string };
  author: { id: number; name: string };
  created_on: string;
  updated_on: string;
  journals?: Array<{ id: number; user: { id: number; name: string }; notes: string; created_on: string; private_notes: boolean }>;
}

export class PlanioClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async listIssues(filters: { projectId?: string; statusId?: string; updatedSince?: Date } = {}): Promise<PlanioIssue[]> {
    const qs = new URLSearchParams({ sort: "updated_on:desc", limit: "100" });
    if (filters.projectId) qs.set("project_id", filters.projectId);
    if (filters.statusId) qs.set("status_id", filters.statusId);
    if (filters.updatedSince) qs.set("updated_on", `>=${filters.updatedSince.toISOString().slice(0, 19)}Z`);

    const data = await this.request<{ issues: PlanioIssue[] }>("GET", `/issues.json?${qs}`);
    return data.issues;
  }

  async getIssue(id: number): Promise<PlanioIssue> {
    const data = await this.request<{ issue: PlanioIssue }>("GET", `/issues/${id}.json?include=journals,attachments`);
    return data.issue;
  }

  /** Ajoute une note. `privateNote: true` = visible en interne seulement (brouillons, diagnostics). */
  async addNote(id: number, notes: string, opts: { privateNote: boolean }): Promise<void> {
    await this.request("PUT", `/issues/${id}.json`, { issue: { notes, private_notes: opts.privateNote } });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "X-Redmine-API-Key": this.apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Planio ${method} ${path} → ${res.status} : ${(await res.text()).slice(0, 500)}`);
    if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
    return (await res.json()) as T;
  }
}
