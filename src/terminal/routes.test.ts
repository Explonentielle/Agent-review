import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeStatusProbe } from "../claude/status.js";
import { registerTerminal, type TerminalFeature } from "./routes.js";
import { TerminalError, TerminalHub, type TerminalLaunch } from "./session.js";

const ECHO = "process.stdin.on('data', (d) => process.stdout.write('echo:' + String(d))); setInterval(() => {}, 1000);";
const fakeLaunch: TerminalLaunch = { file: process.execPath, args: ["-e", ECHO], env: { ...process.env }, cwd: process.cwd() };
const WRITE = { "x-review-agent": "1" };
const OWNER = 1;

describe("routes du terminal Claude", () => {
  let app: FastifyInstance;
  let hub: TerminalHub;
  let launchError: Error | null;
  let statusCode: number;

  async function build(authEnabled: boolean): Promise<void> {
    hub = new TerminalHub({ idleMs: 60_000, maxMs: 60_000, backlogBytes: 4096, maxInputChars: 50 });
    const feature: TerminalFeature = {
      hub,
      launch: async () => {
        if (launchError) throw launchError;
        return fakeLaunch;
      },
      status: createClaudeStatusProbe("claude", () => ({}), async () => ({ code: statusCode, stdout: "Logged in", stderr: "", missing: false }), 0),
    };
    app = Fastify({ logger: false });
    registerTerminal(app, {
      feature,
      authEnabled,
      whoIs: (req) => ({ workspaceId: 1, userId: Number(req.headers["x-user"] ?? OWNER) }),
      ownerUserId: OWNER,
      fail: (reply, err, code = 502) => reply.code(code).send({ error: err instanceof Error ? err.message : String(err) }),
    });
    await app.ready();
  }

  beforeEach(() => {
    launchError = null;
    statusCode = 0;
  });
  afterEach(async () => {
    hub?.stopAll();
    await app?.close();
  });

  it("dit si le terminal est disponible, sinon pourquoi", async () => {
    await build(false);
    const ok = (await app.inject({ method: "GET", url: "/api/terminal" })).json<{ available: boolean; active: boolean; cols: number }>();
    expect(ok).toMatchObject({ available: true, active: false, cols: 100 });
    launchError = new TerminalError("Le terminal n'est disponible que sur Linux");
    const ko = (await app.inject({ method: "GET", url: "/api/terminal" })).json<{ available: boolean; reason: string }>();
    expect(ko.available).toBe(false);
    expect(ko.reason).toContain("Linux");
  });

  it("l'état de la connexion Claude vient de la CLI", async () => {
    await build(false);
    expect((await app.inject({ method: "GET", url: "/api/claude/status" })).json()).toMatchObject({ installed: true, connected: true, detail: "Logged in" });
    statusCode = 1;
    expect((await app.inject({ method: "GET", url: "/api/claude/status?force=1" })).json()).toMatchObject({ connected: false });
  });

  it("derrière un reverse proxy sans connexion par compte, tout est refusé", async () => {
    await build(false);
    for (const header of ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"]) {
      const res = await app.inject({ method: "GET", url: "/api/terminal", headers: { [header]: "203.0.113.9" } });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toContain("AUTH_");
    }
    expect((await app.inject({ method: "POST", url: "/api/terminal/start", headers: { ...WRITE, "x-forwarded-for": "203.0.113.9" } })).statusCode).toBe(403);
    expect(hub.get("1:1")).toBeUndefined();
  });

  it("avec la connexion par compte, le proxy est permis mais seul le propriétaire entre", async () => {
    await build(true);
    expect((await app.inject({ method: "GET", url: "/api/terminal", headers: { "x-forwarded-for": "203.0.113.9" } })).statusCode).toBe(200);
    const other = await app.inject({ method: "POST", url: "/api/terminal/start", headers: { ...WRITE, "x-user": "2" } });
    expect(other.statusCode).toBe(403);
    expect(other.json<{ error: string }>().error).toContain("propriétaire");
    expect((await app.inject({ method: "GET", url: "/api/claude/status", headers: { "x-user": "2" } })).statusCode).toBe(403);
  });

  it("ouvre une session, relaie la saisie et diffuse la sortie en flux continu", async () => {
    await build(false);
    const started = await app.inject({ method: "POST", url: "/api/terminal/start", headers: WRITE });
    expect(started.json()).toMatchObject({ ok: true, cols: 100, rows: 30 });
    expect((await app.inject({ method: "GET", url: "/api/terminal" })).json()).toMatchObject({ active: true });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const input = await fetch(`http://127.0.0.1:${port}/api/terminal/input`, { method: "POST", headers: { ...WRITE, "Content-Type": "application/json" }, body: JSON.stringify({ data: "salut" }) });
    expect(input.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
      const payloads = [...received.matchAll(/event: data\ndata: (\S+)\n\n/g)].map((m) => Buffer.from(m[1]!, "base64").toString());
      if (payloads.join("").includes("echo:salut")) break;
    }
    await reader.cancel();
    const output = [...received.matchAll(/event: data\ndata: (\S+)\n\n/g)].map((m) => Buffer.from(m[1]!, "base64").toString()).join("");
    expect(output).toContain("echo:salut");
  });

  it("refuse la saisie sans session, trop longue ou mal formée ; arrête la session sur demande", async () => {
    await build(false);
    const without = await app.inject({ method: "POST", url: "/api/terminal/input", headers: WRITE, payload: { data: "x" } });
    expect(without.statusCode).toBe(400);
    expect(without.json<{ error: string }>().error).toContain("Aucune session");
    expect((await app.inject({ method: "GET", url: "/api/terminal/stream" })).statusCode).toBe(404);

    await app.inject({ method: "POST", url: "/api/terminal/start", headers: WRITE });
    const long = await app.inject({ method: "POST", url: "/api/terminal/input", headers: WRITE, payload: { data: "x".repeat(51) } });
    expect(long.statusCode).toBe(400);
    expect(long.json<{ error: string }>().error).toContain("trop longue");
    expect((await app.inject({ method: "POST", url: "/api/terminal/input", headers: WRITE, payload: { data: 42 } })).statusCode).toBe(400);

    expect((await app.inject({ method: "POST", url: "/api/terminal/stop", headers: WRITE })).json()).toMatchObject({ ok: true, stopped: true });
    expect((await app.inject({ method: "POST", url: "/api/terminal/stop", headers: WRITE })).json()).toMatchObject({ stopped: false });
  });

  it("un lancement impossible est une erreur lisible, pas un plantage", async () => {
    await build(false);
    launchError = new TerminalError("Le terminal exige l'outil « script »");
    const res = await app.inject({ method: "POST", url: "/api/terminal/start", headers: WRITE });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("script");
  });
});
