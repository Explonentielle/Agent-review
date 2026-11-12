import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeStatusProbe } from "../claude/status.js";
import type { Hero } from "../game/hero.js";
import type { Worker } from "../game/workers.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { TerminalHub } from "../terminal/session.js";
import { buildServer } from "./app.js";

type HeroResponse = Hero & { workers: Worker[] };

describe("API de la forge : héros, quêtes et atelier", () => {
  let h: Harness;
  const apps: FastifyInstance[] = [];

  /** Serveur sur le harnais, avec ou sans le terminal Claude (dont la CLI est simulée connectée ou non). */
  async function serverWith(claude?: { connected: boolean }) {
    const app = buildServer({
      config: h.config,
      forges: h.forges,
      costs: h.costs,
      reviews: h.reviews,
      settings: h.settings,
      tasks: h.tasks,
      vault: h.vault,
      audit: h.audit,
      accounts: h.accounts,
      local: h.local,
      enqueueReview: () => undefined,
      enqueueDev: () => undefined,
      queueSize: () => 0,
      ...(claude
        ? {
            terminal: {
              hub: new TerminalHub(),
              launch: () => ({ file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: { ...process.env }, cwd: process.cwd() }),
              status: createClaudeStatusProbe("claude", () => ({}), async () => ({ code: claude.connected ? 0 : 1, stdout: "ok", stderr: "", missing: false }), 0),
            },
          }
        : {}),
    });
    apps.push(app);
    await app.ready();
    return app;
  }

  const heroOf = async (app: FastifyInstance) => (await app.inject({ method: "GET", url: "/api/hero" })).json<HeroResponse>();

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  it("un outil configuré a déjà de l'XP et des quêtes cochées, et personne à l'atelier", async () => {
    const hero = await heroOf(await serverWith());
    expect(hero.stats.map((s) => s.value)).toEqual([1, 1, 0, 0]); // une forge, un projet, aucune review, aucune pièce
    expect(hero.xp).toBe(50 + 20 + 30);
    expect(hero.level).toBe(2);
    expect(hero.quests.map((q) => [q.id, q.done])).toEqual([["forge", true], ["claude", false], ["project", true], ["dev", true], ["task", false], ["review", false]]);
    expect(hero.nextQuest).toBe("claude");
    expect(hero.workers).toEqual([]);
  });

  it("la connexion Claude se lit auprès de la CLI : connectée, la quête est faite et l'XP monte", async () => {
    const off = await heroOf(await serverWith({ connected: false }));
    expect(off.quests.find((q) => q.id === "claude")!.done).toBe(false);
    const on = await heroOf(await serverWith({ connected: true }));
    expect(on.quests.find((q) => q.id === "claude")!.done).toBe(true);
    expect(on.xp).toBe(off.xp + 100);
    expect(on.nextQuest).toBe("task");
  });

  it("une tâche en cours est un forgeron qui dit sa dernière étape ; l'état suit la tâche", async () => {
    const id = await h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Un ticket", issueUrl: "https://forge.example/i/609", extraInstructions: null });
    await h.tasks.update(id, { status: "running" });
    await h.tasks.addEvent(id, "step", "Lecture du ticket");
    await h.tasks.addEvent(id, "text", "Texte libre du modèle, ignoré tant qu'une étape existe");
    const app = await serverWith();

    expect((await heroOf(app)).workers).toEqual([{ id: `dev-${id}`, kind: "dev", label: "#609 Un ticket", state: "working", line: "Lecture du ticket" }]);

    await h.tasks.update(id, { status: "mr_created" });
    const done = await heroOf(app);
    expect(done.workers.map((w) => w.state)).toEqual(["done"]);
    expect(done.stats[3]!.value).toBe(1); // une pièce forgée
  });

  it("sans terminal fourni, les routes du terminal ne sont pas montées ; avec, elles le sont", async () => {
    expect((await (await serverWith()).inject({ method: "GET", url: "/api/terminal" })).statusCode).toBe(404);
    const withTerminal = await serverWith({ connected: false });
    expect((await withTerminal.inject({ method: "GET", url: "/api/terminal" })).statusCode).toBe(200);
    expect((await withTerminal.inject({ method: "GET", url: "/api/claude/status" })).json()).toMatchObject({ installed: true, connected: false });
  });
});
