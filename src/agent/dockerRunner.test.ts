import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessCancelledError, claudeEnv } from "../claude/process.js";
import { loadConfig } from "../config.js";
import { DEFAULT_SETTINGS } from "../settings/schema.js";
import { CliRunner } from "./cliRunner.js";
import { buildDockerArgs, dockerClientEnv, dockerLauncher, type DockerRuntime } from "./dockerRunner.js";
import { createRunner } from "./index.js";
import type { AgentRequest } from "./runner.js";

const RUNTIME: DockerRuntime = { image: "review-agent:local", memory: "1536m", cpus: 1, pids: 256, network: null, dockerBin: "docker", containerUser: "host" };
const KEY = "cle-api-de-la-tache-a-ne-pas-montrer";
const TOKEN = "jeton-abonnement-de-la-tache-a-ne-pas-montrer";
const resultMsg = (structured: unknown) => JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: structured, total_cost_usd: 0.05, num_turns: 2, session_id: "s1" });

describe("arguments du conteneur d'agent", () => {
  it("conteneur jetable sans privilèges, ressources plafonnées, un seul dossier monté, clé transmise sans valeur", () => {
    const args = buildDockerArgs(RUNTIME, { cwd: "/data/worktrees/projet-12" }, "ra-agent-abc", ["-p", "--model", "claude-sonnet-5-5"], "1000:1000");

    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    const has = (...seq: string[]) => seq.every((_, i) => args.indexOf(seq[0]!) >= 0 && args[args.indexOf(seq[0]!) + i] === seq[i]);
    expect(has("--name", "ra-agent-abc")).toBe(true);
    expect(has("--pull", "never")).toBe(true); // aucun téléchargement implicite
    expect(args).toContain("--read-only");
    expect(has("--cap-drop", "ALL")).toBe(true);
    expect(has("--security-opt", "no-new-privileges")).toBe(true);
    expect(has("--memory", "1536m")).toBe(true);
    expect(has("--memory-swap", "1536m")).toBe(true); // pas de swap au-delà de la mémoire
    expect(has("--cpus", "1")).toBe(true);
    expect(has("--pids-limit", "256")).toBe(true);
    expect(has("--user", "1000:1000")).toBe(true);
    expect(args.filter((a) => a === "--mount")).toHaveLength(1); // un seul montage : le dossier de travail
    expect(args).toContain("type=bind,src=/data/worktrees/projet-12,dst=/work");
    expect(args).toContain("/home/agent:rw,size=256m,uid=1000,gid=1000,mode=700");

    // La clé est nommée, jamais donnée : sa valeur ne peut pas apparaître dans les arguments
    expect(args[args.indexOf("ANTHROPIC_API_KEY") - 1]).toBe("-e");
    expect(args.join(" ")).not.toContain("ANTHROPIC_API_KEY=");
    // Le jeton d'abonnement suit la même règle : nommé, jamais donné
    expect(args[args.indexOf("CLAUDE_CODE_OAUTH_TOKEN") - 1]).toBe("-e");
    expect(args.join(" ")).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(args).not.toContain("-it"); // pas de terminal pour un agent
    // L'image, puis la commande, puis les arguments de la CLI telle quelle
    expect(args.slice(args.indexOf("review-agent:local"))).toEqual(["review-agent:local", "claude", "-p", "--model", "claude-sonnet-5-5"]);
    expect(args).not.toContain("--network");
    expect(buildDockerArgs({ ...RUNTIME, network: "agents" }, { cwd: "/w" }, "n", [], "1:1")).toContain("agents");
  });

  it("Docker sans root : conteneur en root (0:0) et dossier personnel en mémoire au même propriétaire", () => {
    const args = buildDockerArgs(RUNTIME, { cwd: "/w" }, "n", [], "0:0");
    expect(args[args.indexOf("--user") + 1]).toBe("0:0");
    expect(args).toContain("/home/agent:rw,size=256m,uid=0,gid=0,mode=700");
    expect(args).toContain("--cap-drop"); // root du conteneur, mais sans aucune capacité
  });

  it("un dossier de travail relatif ou qui pourrait ajouter une option de montage est refusé", () => {
    for (const bad of ["relatif/dossier", "/ok,src=/etc,dst=/work", "/avec\nsaut", ""]) {
      expect(() => buildDockerArgs(RUNTIME, { cwd: bad }, "n", [], "1:1")).toThrow(/invalide/);
    }
  });

  it("terminal du navigateur : pseudo-terminal et type de terminal, mêmes protections que les agents, toujours un seul dossier monté", () => {
    const args = buildDockerArgs(RUNTIME, { cwd: "/data/terminal" }, "ra-term-abc", [], "1000:1000", "claude", true);
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-it"]);
    expect(args).toContain("TERM=xterm-256color");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args.filter((a) => a === "--mount")).toHaveLength(1);
    expect(args.slice(args.indexOf("review-agent:local"))).toEqual(["review-agent:local", "claude"]);
  });
});

describe("identifiants transmis au client docker", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("la clé API ou le jeton d'abonnement, selon ce qui est fourni, et rien d'autre de l'outil", () => {
    process.env.GITLAB_TOKEN = "jeton-gitlab-de-l-outil";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "jeton-du-shell-de-l-outil";
    process.env.ANTHROPIC_API_KEY = "cle-du-shell-de-l-outil";

    const sub = dockerClientEnv({ oauthToken: TOKEN });
    expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined(); // la clé du shell n'est pas reprise : elle passerait devant l'abonnement
    const api = dockerClientEnv({ apiKey: KEY });
    expect(api.ANTHROPIC_API_KEY).toBe(KEY);
    expect(api.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const none = dockerClientEnv(null);
    expect(none.ANTHROPIC_API_KEY).toBeUndefined();
    expect(none.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    for (const env of [sub, api, none]) expect(env.GITLAB_TOKEN).toBeUndefined();
  });

  it("un conteneur reçoit une clé API ou un jeton, jamais les deux ni aucun", () => {
    expect(() => dockerLauncher(RUNTIME, { apiKey: KEY, oauthToken: TOKEN })).toThrow(/jamais les deux/);
    expect(() => dockerLauncher(RUNTIME, {})).toThrow(/jamais les deux/);
    expect(() => dockerLauncher(RUNTIME, { oauthToken: TOKEN })).not.toThrow();
  });
});

describe.skipIf(process.platform === "win32")("exécution dans un conteneur, avec un faux docker", () => {
  let dir = "";
  const saved = { ...process.env };
  const read = (name: string) => readFileSync(path.join(dir, name), "utf8");

  /** Faux `docker` : enregistre ses appels, son entrée, l'environnement de son processus, et répond comme la CLI Claude Code. */
  function installFakeDocker(runBody = 'cat "$dir/response.txt"'): string {
    const bin = path.join(dir, "docker");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        'dir=$(dirname "$0")',
        // `docker info` : mode du démon (info.txt), ou panne simulée (info-fails) ; n'apparaît pas dans calls.txt
        'if [ "$1" = "info" ]; then echo x >> "$dir/info-calls.txt"; if [ -f "$dir/info-fails" ]; then echo "daemon injoignable" >&2; exit 1; fi; cat "$dir/info.txt" 2>/dev/null || echo "[name=seccomp,profile=builtin name=cgroupns]"; exit 0; fi',
        'echo "$1" >> "$dir/calls.txt"',
        'if [ "$1" = "rm" ]; then printf \'%s\\n\' "$@" > "$dir/rm-args.txt"; exit 0; fi',
        'printf \'%s\\n\' "$@" > "$dir/run-args.txt"',
        'printenv ANTHROPIC_API_KEY > "$dir/keyval.txt"',
        'printenv CLAUDE_CODE_OAUTH_TOKEN > "$dir/tokenval.txt"',
        'env > "$dir/env.txt"',
        runBody,
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    writeFileSync(path.join(dir, "response.txt"), resultMsg({ ok: true }));
    return bin;
  }
  const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    cwd: dir,
    systemPrompt: "SYSTEME",
    prompt: "CONTEXTE",
    outputSchema: { type: "object" },
    tools: ["Read"],
    allowedTools: [],
    disallowedTools: [],
    model: "claude-sonnet-5-5",
    effort: "high",
    maxTurns: 5,
    timeoutMs: 20_000,
    persistSession: false,
    stream: false,
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "docker-runner-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("résultat lu comme avec la CLI directe ; la clé passe par l'environnement du client docker, jamais par les arguments ni avec les secrets de l'outil", async () => {
    process.env.GITLAB_TOKEN = "jeton-gitlab-de-l-outil";
    process.env.SECRETS_MASTER_KEY = "cle-maitre-de-l-outil";
    const runtime = { ...RUNTIME, dockerBin: installFakeDocker() };
    const runner = new CliRunner("claude", () => claudeEnv(KEY), [KEY], dockerLauncher(runtime, { apiKey: KEY }));

    const out = await runner.run(request());
    expect(out).toMatchObject({ structured: { ok: true }, costUsd: 0.05, numTurns: 2, sessionId: "s1" });

    const args = read("run-args.txt");
    expect(args).not.toContain(KEY);
    expect(args).toContain(`type=bind,src=${dir},dst=/work`);
    expect(read("keyval.txt").trim()).toBe(KEY); // transmise au client docker par l'environnement
    expect(read("tokenval.txt").trim()).toBe(""); // pas de jeton d'abonnement en mode clé API
    const env = read("env.txt");
    expect(env).not.toContain("jeton-gitlab-de-l-outil"); // les secrets de l'outil ne vont même pas au client docker
    expect(env).not.toContain("cle-maitre-de-l-outil");

    // Le conteneur est supprimé ensuite, sous le nom qu'il portait
    const name = args.split("\n")[args.split("\n").indexOf("--name") + 1];
    expect(name).toMatch(/^ra-agent-[0-9a-f]{12}$/);
    expect(read("calls.txt").split("\n").filter(Boolean)).toEqual(["run", "rm"]);
    expect(read("rm-args.txt").split("\n").filter(Boolean)).toEqual(["rm", "-f", name]);
  });

  it("annulation : le client docker est arrêté et le conteneur supprimé", async () => {
    const runtime = { ...RUNTIME, dockerBin: installFakeDocker("exec sleep 30") };
    const runner = new CliRunner("claude", () => claudeEnv(KEY), [KEY], dockerLauncher(runtime, { apiKey: KEY }));
    const controller = new AbortController();

    const pending = runner.run(request({ signal: controller.signal, timeoutMs: 60_000 }));
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toBeInstanceOf(ProcessCancelledError);
    expect(read("calls.txt").split("\n").filter(Boolean)).toEqual(["run", "rm"]);
  });

  it("échec de la CLI dans le conteneur : l'erreur ne contient pas la clé, et le conteneur est quand même supprimé", async () => {
    const runtime = { ...RUNTIME, dockerBin: installFakeDocker(`echo '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"échec avec ${KEY}"}'`) };
    const runner = new CliRunner("claude", () => claudeEnv(KEY), [KEY], dockerLauncher(runtime, { apiKey: KEY }));

    const err = await runner.run(request()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Claude Code a échoué/);
    expect((err as Error).message).not.toContain(KEY);
    expect(existsSync(path.join(dir, "rm-args.txt"))).toBe(true);
  });

  it("createRunner : avec AGENT_RUNTIME=docker et la clé API, l'agent passe par docker ; en abonnement sans jeton, c'est refusé", async () => {
    const fake = installFakeDocker();
    const config = loadConfig({ GITHUB_TOKEN: "github_pat_ENV_123456", DATA_DIR: "/tmp/x", ANTHROPIC_API_KEY: KEY, AGENT_RUNTIME: "docker", DOCKER_BIN: fake, AGENT_IMAGE: "mon-image:1", AGENT_MEMORY: "2g" });

    const out = await createRunner(config, { ...DEFAULT_SETTINGS, agentAuth: "api" }).run(request());
    expect(out.structured).toEqual({ ok: true });
    expect(read("run-args.txt")).toContain("mon-image:1");
    expect(read("run-args.txt")).toContain("2g");

    // Jamais de repli sur la machine : sans jeton, l'abonnement est refusé avec la marche à suivre
    expect(() => createRunner(config, { ...DEFAULT_SETTINGS, agentAuth: "subscription" })).toThrow(/claude setup-token/);
    // Les conteneurs sont le défaut : un .env sans AGENT_RUNTIME ne remet jamais les agents sur la machine
    expect(loadConfig({ GITHUB_TOKEN: "github_pat_ENV_123456", DATA_DIR: "/tmp/x" }).agentRuntime).toMatchObject({ mode: "docker", image: "review-agent-sandbox:local", memory: "1536m", cpus: 1, pids: 256, network: null, containerUser: "auto" });
  });

  it("createRunner : en abonnement, le jeton de la personne passe par l'environnement du client docker, jamais par les arguments, et la clé API n'est pas transmise", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-du-shell-de-l-outil";
    const config = loadConfig({ GITHUB_TOKEN: "github_pat_ENV_123456", DATA_DIR: "/tmp/x", AGENT_RUNTIME: "docker", DOCKER_BIN: installFakeDocker(), AGENT_CONTAINER_USER: "host" });
    config.claudeOauthToken = TOKEN;
    config.anthropicApiKey = KEY; // une clé définie ailleurs ne doit pas passer devant l'abonnement

    const out = await createRunner(config, { ...DEFAULT_SETTINGS, agentAuth: "subscription" }).run(request());
    expect(out.structured).toEqual({ ok: true });
    expect(read("tokenval.txt").trim()).toBe(TOKEN);
    expect(read("keyval.txt").trim()).toBe("");
    expect(read("run-args.txt")).not.toContain(TOKEN);
    expect(read("env.txt")).not.toContain("cle-du-shell-de-l-outil");
  });

  it("createRunner : une erreur de la CLI en abonnement ne contient pas le jeton", async () => {
    const runtimeConfig = loadConfig({
      GITHUB_TOKEN: "github_pat_ENV_123456",
      DATA_DIR: "/tmp/x",
      AGENT_RUNTIME: "docker",
      AGENT_CONTAINER_USER: "host",
      DOCKER_BIN: installFakeDocker(`echo '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"échec avec ${TOKEN}"}'`),
    });
    runtimeConfig.claudeOauthToken = TOKEN;
    const err = await createRunner(runtimeConfig, { ...DEFAULT_SETTINGS, agentAuth: "subscription" }).run(request()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Claude Code a échoué/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("createRunner : l'image du projet est lancée si elle est autorisée, sinon la tâche est refusée avant tout conteneur", async () => {
    const config = loadConfig({
      GITHUB_TOKEN: "github_pat_ENV_123456",
      DATA_DIR: "/tmp/x",
      ANTHROPIC_API_KEY: KEY,
      AGENT_RUNTIME: "docker",
      DOCKER_BIN: installFakeDocker(),
      AGENT_CONTAINER_USER: "host",
      AGENT_IMAGE: "defaut:1",
      AGENT_IMAGES: "agent-php73:1",
    });
    const settings = { ...DEFAULT_SETTINGS, agentAuth: "api" as const };
    const imageLaunched = () => {
      const args = read("run-args.txt").split("\n");
      return args[args.indexOf("claude") - 1]; // l'image précède le programme lancé
    };

    await createRunner(config, settings, { agentImage: "agent-php73:1" }).run(request());
    expect(imageLaunched()).toBe("agent-php73:1");
    await createRunner(config, settings, { agentImage: "" }).run(request());
    expect(imageLaunched()).toBe("defaut:1");
    await createRunner(config, settings, null).run(request());
    expect(imageLaunched()).toBe("defaut:1");

    expect(() => createRunner(config, settings, { agentImage: "intrus:1" })).toThrow(/non autorisée/);
    // Sur la machine, l'image d'un projet est sans objet : la tâche ne casse pas
    const onHost = { ...config, agentRuntime: { ...config.agentRuntime, mode: "host" as const } };
    expect(() => createRunner(onHost, settings, { agentImage: "intrus:1" })).not.toThrow();
  });

  describe("utilisateur du conteneur selon le mode de Docker", () => {
    const argAfter = (flag: string) => {
      const args = read("run-args.txt").split("\n");
      return args[args.indexOf(flag) + 1];
    };
    const run = (containerUser: DockerRuntime["containerUser"], bin: string) =>
      new CliRunner("claude", () => claudeEnv(KEY), [KEY], dockerLauncher({ ...RUNTIME, dockerBin: bin, containerUser }, { apiKey: KEY })).run(request());
    const hostUser = `${process.getuid?.()}:${process.getgid?.()}`;

    it("auto, Docker sans root détecté : root du conteneur, qui est l'utilisateur de l'outil pour la machine", async () => {
      const bin = installFakeDocker();
      writeFileSync(path.join(dir, "info.txt"), "[name=seccomp,profile=builtin name=rootless name=cgroupns]");
      await run("auto", bin);
      expect(argAfter("--user")).toBe("0:0");
      expect(read("run-args.txt")).toContain("/home/agent:rw,size=256m,uid=0,gid=0,mode=700");
    });

    it("auto, Docker classique : l'UID et le GID du processus de l'outil", async () => {
      const bin = installFakeDocker();
      await run("auto", bin);
      expect(argAfter("--user")).toBe(hostUser);
    });

    it("en mode auto, la détection n'est faite qu'une fois par démon", async () => {
      const bin = installFakeDocker();
      await run("auto", bin);
      await run("auto", bin);
      expect(read("info-calls.txt").split("\n").filter(Boolean)).toHaveLength(1);
    });

    it("choix explicite (host ou root) : Docker n'est pas interrogé, même s'il annonce le contraire", async () => {
      const bin = installFakeDocker();
      writeFileSync(path.join(dir, "info.txt"), "[name=rootless]");
      await run("host", bin);
      expect(argAfter("--user")).toBe(hostUser);
      writeFileSync(path.join(dir, "info.txt"), "[name=seccomp,profile=builtin]");
      await run("root", bin);
      expect(argAfter("--user")).toBe("0:0");
      expect(existsSync(path.join(dir, "info-calls.txt"))).toBe(false);
    });

    it("auto, Docker injoignable : erreur claire, aucun conteneur lancé, et la panne n'est pas mémorisée", async () => {
      const bin = installFakeDocker();
      writeFileSync(path.join(dir, "info-fails"), "");
      await expect(run("auto", bin)).rejects.toThrow(/Impossible d'interroger Docker/);
      expect(existsSync(path.join(dir, "calls.txt"))).toBe(false);

      // Docker répond de nouveau, et il est sans root : la réponse est lue, pas celle d'avant la panne
      rmSync(path.join(dir, "info-fails"));
      writeFileSync(path.join(dir, "info.txt"), "[name=rootless]");
      await run("auto", bin);
      expect(argAfter("--user")).toBe("0:0");
    });
  });
});

describe("configuration de l'exécution des agents", () => {
  const base = { GITHUB_TOKEN: "github_pat_ENV_123456", DATA_DIR: "/tmp/x" };

  it("valeurs invalides refusées au démarrage", () => {
    expect(() => loadConfig({ ...base, AGENT_RUNTIME: "kubernetes" })).toThrow(/AGENT_RUNTIME/);
    expect(() => loadConfig({ ...base, AGENT_MEMORY: "beaucoup" })).toThrow(/AGENT_MEMORY/);
    expect(() => loadConfig({ ...base, AGENT_CPUS: "0" })).toThrow(/AGENT_CPUS/);
    expect(() => loadConfig({ ...base, AGENT_NETWORK: "--privileged" })).toThrow(/AGENT_NETWORK/);
    expect(() => loadConfig({ ...base, AGENT_CONTAINER_USER: "admin" })).toThrow(/AGENT_CONTAINER_USER/);
    expect(loadConfig({ ...base, AGENT_CONTAINER_USER: "root" }).agentRuntime.containerUser).toBe("root");
    expect(loadConfig({ ...base, AGENT_NETWORK: "agents-net", AGENT_CPUS: "1.5" }).agentRuntime).toMatchObject({ network: "agents-net", cpus: 1.5 });
  });
});
