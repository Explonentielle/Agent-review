import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequest, AgentRunner } from "../agent/runner.js";
import { DRAFTS_PER_HOUR } from "../rooms/userRoutes.js";
import { ROOM_TEMPLATE } from "../rooms/template.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

const WRITE = { "x-review-agent": "1" };
const valid = () => ({ room_json: JSON.stringify(ROOM_TEMPLATE), notes: ["Voilà ta salle."] });

describe("API du générateur de salles", () => {
  let h: Harness;
  let app: ReturnType<typeof buildServer>;
  let requests: AgentRequest[];
  let answer: unknown;

  beforeEach(async () => {
    h = await createHarness();
    requests = [];
    answer = valid();
    const runner: AgentRunner = { async run(req) { requests.push(req); return { structured: answer, sessionId: null, costUsd: 0.01, numTurns: 1 }; } };
    app = buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0, scribeRunner: runner,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await h.cleanup();
  });

  const draft = (payload: unknown, headers: Record<string, string> = WRITE) => app.inject({ method: "POST", url: "/api/rooms/draft", headers, payload: payload as object });

  it("génère une salle : l'agent n'a aucun outil, reçoit le catalogue et les garde-fous, et rien n'est gardé", async () => {
    const res = await draft({ idea: "une petite taverne avec un tavernier" });
    expect(res.statusCode).toBe(200);
    const out = res.json<{ room: { id: string; hub: boolean }; notes: string[]; attempts: number; solved: boolean | null; warnings: string[] }>();
    expect(out.room.hub).toBe(false);
    expect(out.notes).toEqual(["Voilà ta salle."]);
    expect(out.attempts).toBe(1);
    expect(out.solved).toBeNull();

    const req = requests[0]!;
    expect(req.tools).toEqual([]);
    expect(req.persistSession).toBe(false);
    expect(req.systemPrompt).toContain("Architecte"); // le prompt de base
    expect(req.systemPrompt).toContain("# Catalogue"); // généré depuis le code
    expect(req.systemPrompt).toContain('"id":"arcade"'); // l'exemple livré
    expect(req.systemPrompt).toContain("Règles de sécurité (non modifiables"); // les garde-fous sont toujours ajoutés
    expect(req.prompt).toContain("une petite taverne");
    // un brouillon n'écrit jamais : aucune salle n'est gardée
    expect((await app.inject({ method: "GET", url: "/api/user-rooms" })).json<{ rooms: unknown[] }>().rooms).toEqual([]);
  });

  it("refuse sans l'en-tête anti-CSRF, et une demande trop courte", async () => {
    expect((await draft({ idea: "une taverne" }, {})).statusCode).toBe(403);
    expect((await draft({ idea: "" })).statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("répond 502 avec la liste des problèmes quand l'agent ne produit rien de valide", async () => {
    answer = { room_json: JSON.stringify({ ...JSON.parse(JSON.stringify(ROOM_TEMPLATE)), theme: "espace" }), notes: [] };
    const res = await draft({ idea: "une salle impossible à valider" });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string; errors: string[] }>().errors.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(3); // trois essais, chacun corrigé par les contrôles
  });

  it("plafonne le nombre de générations par heure et par personne", async () => {
    for (let i = 0; i < DRAFTS_PER_HOUR; i++) expect((await draft({ idea: `une salle numéro ${i}` })).statusCode).toBe(200);
    const res = await draft({ idea: "une salle de trop" });
    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: string }>().error).toMatch(/Trop de salles générées/);
  });
});
