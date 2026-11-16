import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSecret } from "../logger.js";
import { createAuditRepo, type AuditEntry, type AuditRepo } from "../db/audit.js";
import type { RepoWorkspace } from "../review/workspace.js";
import { FakeConnector } from "../testing/fakeConnector.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { auditConnector, auditWorkspace } from "./audited.js";

describe("journal d'audit des écritures sur les forges", () => {
  let h: Harness;
  let audit: AuditRepo;
  beforeEach(async () => {
    h = await createHarness();
    audit = createAuditRepo(h.db, h.local.workspaceId, h.local.userId);
  });
  afterEach(() => h.cleanup());

  /** Lignes du journal, de la plus ancienne à la plus récente, avec le détail lu. */
  const entries = async () => (await audit.list()).reverse().map((e: AuditEntry) => ({ action: e.action, source: e.source, target: e.target, outcome: e.outcome, error: e.error, detail: e.detail ? JSON.parse(e.detail) : null, user: e.user_id }));

  it("chaque écriture est tracée avec sa cible, son auteur et son résultat ; le résultat de l'action est rendu intact", async () => {
    const forge = new FakeConnector({ cloneUrl: "file:///x" }, "github");
    const connector = auditConnector(forge, audit);

    expect(connector.kind).toBe("github");
    await connector.addTicketLabels(5, 12, ["Statut::En cours"]);
    const created = await connector.createChangeRequest(5, { sourceBranch: "feature/12-x", targetBranch: "develop", title: "Draft: x", description: "texte" });
    await connector.commentOnChangeRequest(5, created.iid, "rapport confidentiel de l'agent", "note");
    await connector.approveChangeRequest(5, created.iid, "a".repeat(40));

    expect(created.title).toBe("Draft: x"); // le vrai résultat de l'action, pas une copie
    expect(forge.createdChangeRequests).toHaveLength(1); // et l'écriture a bien eu lieu chez la forge
    expect(forge.postedComments[0]!.body).toBe("rapport confidentiel de l'agent");

    expect(await entries()).toEqual([
      { action: "ticket_labels", source: "github", target: "5/12", outcome: "ok", error: null, detail: { labels: ["Statut::En cours"] }, user: h.local.userId },
      { action: "change_request_create", source: "github", target: `5/${created.iid}`, outcome: "ok", error: null, detail: { sourceBranch: "feature/12-x", targetBranch: "develop", title: "Draft: x", url: created.url }, user: h.local.userId },
      { action: "change_request_comment", source: "github", target: `5/${created.iid}`, outcome: "ok", error: null, detail: { kind: "note", length: 31 }, user: h.local.userId },
      { action: "change_request_approve", source: "github", target: `5/${created.iid}`, outcome: "ok", error: null, detail: { headSha: "a".repeat(40) }, user: h.local.userId },
    ]);
    expect(JSON.stringify(await audit.list())).not.toContain("confidentiel"); // le texte des commentaires n'est jamais gardé
  });

  it("la création d'un ticket et d'un projet est tracée, y compris quand la forge refuse", async () => {
    const forge = new FakeConnector({ cloneUrl: "file:///x" }, "gitlab");
    const connector = auditConnector(forge, audit);

    const ticket = await connector.createTicket(5, { title: "Ajouter un export", description: "texte confidentiel", labels: ["Statut::A traiter"] });
    const project = await connector.createProject({ name: "Mon outil", description: "d", namespaceId: "2", private: true, withReadme: true });
    forge.failNextWrite = new Error("403 Forbidden");
    await expect(connector.createTicket(5, { title: "Refusé", description: "x" })).rejects.toThrow("403");

    expect(forge.createdTickets.length).toBe(1); // la création refusée n est pas enregistrée chez la forge
    expect(forge.createdProjects.length).toBe(1);
    expect(await entries()).toEqual([
      { action: "ticket_create", source: "gitlab", target: `5/${ticket.iid}`, outcome: "ok", error: null, detail: { title: "Ajouter un export", labels: ["Statut::A traiter"], url: ticket.url }, user: h.local.userId },
      { action: "project_create", source: "gitlab", target: project.path, outcome: "ok", error: null, detail: { namespaceId: "2", private: true, url: project.url }, user: h.local.userId },
      { action: "ticket_create", source: "gitlab", target: "5/?", outcome: "error", error: "403 Forbidden", detail: { title: "Refusé", labels: [], url: undefined }, user: h.local.userId },
    ]);
    expect(JSON.stringify(await audit.list())).not.toContain("confidentiel"); // la description d'un ticket n'est jamais gardée
  });

  it("les lectures ne laissent aucune trace", async () => {
    const forge = new FakeConnector({ cloneUrl: "file:///x" });
    forge.tickets.set(1, h.ticket({ iid: 1 }));
    const connector = auditConnector(forge, audit);

    await connector.getCurrentUser();
    await connector.listAssignedTickets();
    await connector.getTicket(1, 1);
    await connector.getCheckStatuses(1, "abc");
    expect(connector.gitCredentials()).toEqual({ username: "oauth2", token: "token-factice" });
    expect(await audit.list()).toEqual([]);
  });

  it("une écriture qui échoue est tracée avec son erreur (secrets masqués) puis l'erreur est relayée", async () => {
    registerSecret("jeton-qui-fuit-dans-l-erreur-42");
    const forge = new FakeConnector({ cloneUrl: "file:///x" });
    forge.approveChangeRequest = async () => {
      throw new Error("403 Forbidden pour jeton-qui-fuit-dans-l-erreur-42");
    };
    const connector = auditConnector(forge, audit);

    await expect(connector.approveChangeRequest(5, 12, "b".repeat(40))).rejects.toThrow(/403 Forbidden/);
    const [entry] = await entries();
    expect(entry).toMatchObject({ action: "change_request_approve", outcome: "error", target: "5/12" });
    expect(entry!.error).toBe("403 Forbidden pour [secret]");
  });

  it("un journal en panne ne bloque jamais l'action", async () => {
    const forge = new FakeConnector({ cloneUrl: "file:///x" });
    const broken: AuditRepo = { ...audit, record: async () => Promise.reject(new Error("base indisponible")) };
    const connector = auditConnector(forge, broken);

    await expect(connector.commentOnChangeRequest(5, 12, "ok", "review")).resolves.toBeUndefined();
    expect(forge.postedComments).toHaveLength(1);
  });

  it("branches poussées : tracées, réussies ou non, les autres méthodes passent telles quelles", async () => {
    const pushed: string[] = [];
    class FakeWorkspace {
      reposDir = "/x";
      async pushBranch(_worktree: string, branch: string) {
        if (branch === "feature/refuse") throw new Error("rejet du push");
        pushed.push(branch);
      }
      async other() {
        return this.reposDir; // `this` doit rester celui de l'original
      }
    }
    const workspace = auditWorkspace(new FakeWorkspace() as unknown as RepoWorkspace, audit, "gitlab");

    await workspace.pushBranch("/w", "feature/609-x");
    await expect(workspace.pushBranch("/w", "feature/refuse")).rejects.toThrow("rejet du push");
    expect(pushed).toEqual(["feature/609-x"]);
    expect(await (workspace as unknown as { other(): Promise<string> }).other()).toBe("/x");

    expect(await entries()).toEqual([
      { action: "push_branch", source: "gitlab", target: "feature/609-x", outcome: "ok", error: null, detail: null, user: h.local.userId },
      { action: "push_branch", source: "gitlab", target: "feature/refuse", outcome: "error", error: "rejet du push", detail: null, user: h.local.userId },
    ]);
  });

  it("pagination et plafond du journal", async () => {
    for (let i = 1; i <= 5; i++) await audit.record({ source: "gitlab", action: "ticket_labels", target: `1/${i}` });
    const all = await audit.list();
    expect(all.map((e) => e.target)).toEqual(["1/5", "1/4", "1/3", "1/2", "1/1"]);
    expect((await audit.list(2)).map((e) => e.target)).toEqual(["1/5", "1/4"]);
    expect((await audit.list(10, all[2]!.id)).map((e) => e.target)).toEqual(["1/2", "1/1"]);

    await audit.record({ source: "gitlab", action: "x", target: "y", detail: { long: "z".repeat(5000) }, error: "e".repeat(2000) });
    const [last] = await audit.list(1);
    expect(last!.detail!.length).toBeLessThanOrEqual(2000);
    expect(last!.error!.length).toBe(500);
  });
});
