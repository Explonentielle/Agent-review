import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAttachmentStore, type AttachmentInfo, type AttachmentStore } from "../attachments/store.js";
import { LIMITS } from "../attachments/rules.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

const WRITE = { "x-review-agent": "1" };
const BIN = { ...WRITE, "content-type": "application/octet-stream" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("capture")]);
const CSV = Buffer.from("a;b\n1;2\n", "utf8");
const TICKET = { source: "gitlab", projectId: 1, iid: 609 };

describe("API des pièces jointes", () => {
  let h: Harness;
  let store: AttachmentStore;
  let app: ReturnType<typeof buildServer>;
  let enqueuedDev: number[];

  const serve = (attachments: AttachmentStore | undefined) =>
    buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      ...(attachments ? { attachments } : {}),
      enqueueReview: () => undefined, enqueueDev: (id) => enqueuedDev.push(id), queueSize: () => 0,
    });
  const upload = async (name: string, body: Buffer, headers: Record<string, string> = BIN): Promise<AttachmentInfo> => {
    const res = await app.inject({ method: "POST", url: `/api/attachments?name=${encodeURIComponent(name)}`, headers, payload: body });
    expect(res.statusCode).toBe(200);
    return res.json() as AttachmentInfo;
  };
  const startTask = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload: { projectId: 1, issueIid: 609, ...payload } });
  const attachmentsOf = async (taskId: number) => ((await app.inject({ method: "GET", url: `/api/tasks/${taskId}/attachments` })).json() as { attachments: AttachmentInfo[] }).attachments.map((f) => f.name);

  beforeEach(async () => {
    h = await createHarness();
    enqueuedDev = [];
    h.connector.tickets.set(609, h.ticket());
    store = createAttachmentStore(path.join(h.config.dataDir, "attachments"), h.local.workspaceId);
    app = serve(store);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await h.cleanup();
  });

  it("envoie un fichier : il est contrôlé, nommé proprement et mis en attente", async () => {
    const info = await upload("../../Capture d'écran.PNG", PNG);
    expect(info).toMatchObject({ name: "Capture d_écran.png", kind: "image", size: PNG.length });
    expect(info.id).toMatch(/^[0-9a-f]{20}$/);
  });

  it("refuse un envoi sans l'en-tête anti-CSRF", async () => {
    const res = await app.inject({ method: "POST", url: "/api/attachments?name=a.png", headers: { "content-type": "application/octet-stream" }, payload: PNG });
    expect(res.statusCode).toBe(403);
  });

  it("refuse un type interdit, une fausse image, un fichier vide et un envoi sans contenu, avec un message lisible", async () => {
    const send = (name: string, body: Buffer) => app.inject({ method: "POST", url: `/api/attachments?name=${name}`, headers: BIN, payload: body });
    const exe = await send("virus.exe", Buffer.from("MZ"));
    expect(exe.statusCode).toBe(400);
    expect((exe.json() as { error: string }).error).toMatch(/pas accepté/);
    expect((await send("fausse.png", Buffer.from("texte"))).json()).toMatchObject({ error: expect.stringMatching(/vraie image/) });
    expect((await send("vide.txt", Buffer.alloc(0))).statusCode).toBe(400);
    const json = await app.inject({ method: "POST", url: "/api/attachments?name=a.png", headers: { ...WRITE, "content-type": "application/json" }, payload: { x: 1 } });
    expect(json.statusCode).toBe(400);
  });

  it("refuse un fichier trop gros avec le bon code", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(LIMITS.maxBinaryBytes + 1024)]);
    const res = await app.inject({ method: "POST", url: "/api/attachments?name=grosse.png", headers: BIN, payload: big });
    expect(res.statusCode).toBe(413);
    expect((res.json() as { error: string }).error).toMatch(/trop gros/);
  });

  it("retire un fichier en attente", async () => {
    const info = await upload("a.png", PNG);
    const res = await app.inject({ method: "POST", url: `/api/attachments/${info.id}/discard`, headers: WRITE });
    expect(res.json()).toEqual({ ok: true, existed: true });
    expect((await app.inject({ method: "POST", url: `/api/attachments/${info.id}/discard`, headers: WRITE })).json()).toEqual({ ok: true, existed: false });
    expect((await app.inject({ method: "POST", url: "/api/attachments/..%2F..%2Fetc/discard", headers: WRITE })).json()).toMatchObject({ existed: false });
  });

  it("une tâche lancée avec des fichiers les reçoit, et le journal le dit", async () => {
    const a = await upload("capture.png", PNG);
    const b = await upload("regles.csv", CSV);
    const res = await startTask({ attachments: [a.id, b.id] });
    expect(res.statusCode).toBe(200);
    const { id } = res.json() as { id: number };
    expect(await attachmentsOf(id)).toEqual(["capture.png", "regles.csv"]);
    expect((await h.tasks.events(id)).map((e) => e.text)).toContain("Pièces jointes : capture.png, regles.csv");
    expect(enqueuedDev).toEqual([id]);
  });

  it("un fichier refusé ne crée aucune tâche, et les autres restent en attente", async () => {
    const a = await upload("capture.png", PNG);
    const res = await startTask({ attachments: [a.id, "0123456789abcdef0123"] });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/n'existe plus/);
    expect(await h.tasks.list()).toEqual([]);
    expect(enqueuedDev).toEqual([]);
    expect((await startTask({ attachments: [a.id] })).statusCode).toBe(200); // le fichier valide n'a pas été perdu
  });

  it("refuse une liste de fichiers mal formée ou trop longue", async () => {
    expect((await startTask({ attachments: "capture.png" })).statusCode).toBe(400);
    expect((await startTask({ attachments: [1, 2] })).statusCode).toBe(400);
    expect((await startTask({ attachments: Array.from({ length: LIMITS.maxFiles + 1 }, () => "0123456789abcdef0123") })).statusCode).toBe(400);
    expect(await h.tasks.list()).toEqual([]);
  });

  it("les fichiers joints au ticket (créé avec le Scribe) suivent la tâche lancée sur ce ticket", async () => {
    await store.attach({ ticket: TICKET }, [(await store.stage("maquette.png", PNG)).id]);
    const { id } = (await startTask({})).json() as { id: number };
    expect(await attachmentsOf(id)).toEqual(["maquette.png"]);
  });

  it("une relance garde les fichiers de l'essai précédent, sans doublon avec ceux du ticket", async () => {
    await store.attach({ ticket: TICKET }, [(await store.stage("maquette.png", PNG)).id]);
    const first = (await startTask({ attachments: [(await upload("donnees.csv", CSV)).id] })).json() as { id: number };
    expect(await attachmentsOf(first.id)).toEqual(["maquette.png", "donnees.csv"]);
    await h.tasks.update(first.id, { status: "error" });
    const again = (await startTask({ retryOf: first.id })).json() as { id: number };
    expect(await attachmentsOf(again.id)).toEqual(["maquette.png", "donnees.csv"]);
  });

  it("une reprise garde les fichiers de la tâche reprise et peut en recevoir d'autres", async () => {
    const origin = await h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import", issueUrl: "https://forge.example/i/609", extraInstructions: null });
    await h.tasks.update(origin, { status: "mr_created", branch: "feature/609-import", base_branch: "develop", target_branch: "develop", mr_iid: 12, mr_url: "https://forge.example/mr/12" });
    await store.attach({ task: origin }, [(await store.stage("capture.png", PNG)).id]);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${origin}/followup`, headers: WRITE, payload: { instructions: "Corrige", attachments: [(await upload("regles.csv", CSV)).id] } });
    expect(res.statusCode).toBe(200);
    expect(await attachmentsOf((res.json() as { id: number }).id)).toEqual(["capture.png", "regles.csv"]);
  });

  it("supprimer une tâche supprime ses fichiers", async () => {
    const { id } = (await startTask({ attachments: [(await upload("capture.png", PNG)).id] })).json() as { id: number };
    await h.tasks.update(id, { status: "error" });
    expect((await app.inject({ method: "POST", url: `/api/tasks/${id}/delete`, headers: WRITE })).statusCode).toBe(200);
    expect(await store.list({ task: id })).toEqual([]);
    expect(existsSync(path.join(h.config.dataDir, "attachments", String(h.local.workspaceId), `task-${id}`))).toBe(false);
  });

  it("sans stockage de pièces jointes : l'envoi est refusé proprement et une tâche sans fichier part normalement", async () => {
    const bare = serve(undefined);
    await bare.ready();
    try {
      const up = await bare.inject({ method: "POST", url: "/api/attachments?name=a.png", headers: BIN, payload: PNG });
      expect(up.statusCode).toBe(501);
      const withFile = await bare.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload: { projectId: 1, issueIid: 609, attachments: ["0123456789abcdef0123"] } });
      expect(withFile.statusCode).toBe(501);
      expect(await h.tasks.list()).toEqual([]);
      const plain = await bare.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload: { projectId: 1, issueIid: 609 } });
      expect(plain.statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});
