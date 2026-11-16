import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAttachmentStore, type AttachmentStore } from "../attachments/store.js";
import { auditConnector } from "../connectors/audited.js";
import { ForgeRegistry } from "../connectors/registry.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "../server/app.js";
import { cleanUploadMarkdown } from "./clean.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("capture")]);
const CSV = Buffer.from("a;b\n1;2\n", "utf8");

describe("lien de fichier renvoyé par la forge", () => {
  it("accepte un lien d'envoi du projet, image ou fichier, avec des caractères encodés", () => {
    expect(cleanUploadMarkdown("![capture](/uploads/0123456789abcdef0123456789abcdef/capture.png)")).toBe("![capture](/uploads/0123456789abcdef0123456789abcdef/capture.png)");
    expect(cleanUploadMarkdown("[regles](/uploads/ab12cd34ef56ab12/regles%20(2).csv)")).toBe("[regles](/uploads/ab12cd34ef56ab12/regles%20(2).csv)");
    expect(cleanUploadMarkdown("  ![a](/uploads/ab12cd34ef56ab12/a.png)\n")).toBe("![a](/uploads/ab12cd34ef56ab12/a.png)");
  });
  it("refuse tout le reste : autre site, HTML, plusieurs lignes, autre chemin, valeur inattendue", () => {
    for (const bad of [
      "![x](https://evil.example/a.png)",
      "[x](javascript:alert(1))",
      "![x](/uploads/ab12cd34ef56ab12/a.png)\n![y](https://evil.example/b.png)",
      "![x](/autre/ab12cd34ef56ab12/a.png)",
      "![x](/uploads/xyz/a.png)",
      "<img src=/uploads/ab12cd34ef56ab12/a.png>",
      "![<b>](/uploads/ab12cd34ef56ab12/a.png)",
      "",
      null,
      42,
    ]) {
      expect(cleanUploadMarkdown(bad)).toBeNull();
    }
  });
});

describe("Scribe : fichiers joints à un ticket", () => {
  let h: Harness;
  let store: AttachmentStore;
  const apps: FastifyInstance[] = [];

  async function server() {
    const forges = new ForgeRegistry(h.forges.all().map((f) => ({ ...f, connector: auditConnector(f.connector, h.audit) })));
    const app = buildServer({
      config: h.config, forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      attachments: store, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
    });
    apps.push(app);
    await app.ready();
    return app;
  }
  const createTicket = (app: FastifyInstance, attachments: string[]) =>
    app.inject({ method: "POST", url: "/api/scribe/tickets", headers: { "x-review-agent": "1" }, payload: { source: "gitlab", projectId: 1, title: "Refaire l'écran", description: "## Contexte\nVoir la maquette.", labels: [], attachments } });
  const stage = async () => [(await store.stage("capture.png", PNG)).id, (await store.stage("regles.csv", CSV)).id];

  beforeEach(async () => {
    h = await createHarness();
    store = createAttachmentStore(path.join(h.config.dataDir, "attachments"), h.local.workspaceId);
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    await h.cleanup();
  });

  it("chez GitLab : les fichiers sont envoyés au projet, leurs liens sont dans la description, et ils suivent le ticket pour l'agent dev", async () => {
    const ids = await stage();
    const res = await createTicket(await server(), ids);
    expect(res.statusCode).toBe(200);
    const out = res.json<{ iid: number; attachments: { files: number; uploaded: number; kept: number } }>();
    expect(out.attachments).toEqual({ files: 2, uploaded: 2, kept: 2 });

    expect(h.connector.uploadedFiles).toEqual([
      { projectId: 1, name: "capture.png", size: PNG.length },
      { projectId: 1, name: "regles.csv", size: CSV.length },
    ]);
    const created = h.connector.createdTickets[0]!.input;
    expect(created.description).toContain("## Contexte\nVoir la maquette.");
    expect(created.description).toContain("## Pièces jointes");
    expect(created.description).toContain("![capture.png](/uploads/");
    expect(created.description).toContain("![regles.csv](/uploads/");

    expect((await store.list({ ticket: { source: "gitlab", projectId: 1, iid: out.iid } })).map((f) => f.name)).toEqual(["capture.png", "regles.csv"]);
    const audited = (await h.audit.list()).filter((e) => e.action === "ticket_file_upload");
    expect(audited).toHaveLength(2);
    expect(JSON.stringify(audited)).not.toContain("capture\u0000"); // le journal garde le nom et le poids, pas le contenu
  });

  it("chez une forge sans envoi de fichier (GitHub) : la description reste telle quelle, les fichiers sont gardés pour l'agent", async () => {
    h.connector.supportsUploads = false;
    const res = await createTicket(await server(), await stage());
    expect(res.statusCode).toBe(200);
    const out = res.json<{ iid: number; attachments: { files: number; uploaded: number; kept: number } }>();
    expect(out.attachments).toEqual({ files: 2, uploaded: 0, kept: 2 });
    expect(h.connector.createdTickets[0]!.input.description).not.toContain("Pièces jointes");
    expect(await store.list({ ticket: { source: "gitlab", projectId: 1, iid: out.iid } })).toHaveLength(2);
  });

  it("un fichier inconnu : rien n'est envoyé ni créé chez la forge", async () => {
    const [good] = await stage();
    const res = await createTicket(await server(), [good!, "0123456789abcdef0123"]);
    expect(res.statusCode).toBe(404);
    expect(h.connector.uploadedFiles).toEqual([]);
    expect(h.connector.createdTickets).toEqual([]);
  });

  it("la forge refuse l'envoi d'un fichier : le ticket n'est pas créé sans ses fichiers, qui restent en attente", async () => {
    const ids = await stage();
    h.connector.failNextWrite = new Error("403 Forbidden");
    const app = await server();
    const res = await createTicket(app, ids);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(h.connector.createdTickets).toEqual([]);
    expect((await createTicket(app, ids)).statusCode).toBe(200); // les fichiers n'ont pas été perdus : une nouvelle tentative marche
  });

  it("un Markdown piégé renvoyé par la forge n'entre jamais dans la description", async () => {
    h.connector.uploadTicketFile = async () => ({ markdown: "![x](https://evil.example/a.png)<script>alert(1)</script>" });
    const res = await createTicket(await server(), await stage());
    expect(res.statusCode).toBe(200);
    expect(res.json<{ attachments: { uploaded: number } }>().attachments.uploaded).toBe(0);
    expect(h.connector.createdTickets[0]!.input.description).not.toContain("evil.example");
  });

  it("sans fichier, le ticket part comme avant (aucun envoi, aucun dossier)", async () => {
    const res = await createTicket(await server(), []);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ attachments: { files: number } }>().attachments.files).toBe(0);
    expect(h.connector.uploadedFiles).toEqual([]);
    expect(h.connector.createdTickets[0]!.input.description).toBe("## Contexte\nVoir la maquette.");
  });
});
