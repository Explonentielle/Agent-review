import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { diagnoseAgentRuntime, type RuntimeCheck, type RuntimeContext } from "./dockerDiagnostic.js";

const PROBE_OK = ["write=ok", "root=ok", "user=1000:1000", "mem=1610612736", "pids=256", "caps=0000000000000000", "nnp=1"].join("\n");

/** Faux `docker` : répond à `info`, `image inspect`, `rm` et `run` d'après les fichiers posés à côté de lui, et note ce qu'il reçoit. */
const FAKE_DOCKER = String.raw`#!/bin/sh
dir=$(dirname "$0")
case "$1" in
  info)
    echo x >> "$dir/info-calls.txt"
    if [ -f "$dir/info-fails" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    cat "$dir/info.txt"
    exit 0;;
  image)
    if [ -f "$dir/image-missing" ]; then echo "Error: No such image" >&2; exit 1; fi
    echo "sha256:abc"
    exit 0;;
  rm)
    printf '%s\n' "$3" >> "$dir/rm-names.txt"
    exit 0;;
  run)
    printf '%s\n' "$@" >> "$dir/runs.txt"
    echo "----" >> "$dir/runs.txt"
    env > "$dir/env.txt"
    case " $* " in
      *" claude --version "*)
        if [ -f "$dir/claude-fails" ]; then echo "exec: claude: not found" >&2; exit 127; fi
        cat "$dir/claude.txt";;
      *)
        if [ -f "$dir/probe-fails" ]; then echo "cannot start the container" >&2; exit 125; fi
        cat "$dir/probe.txt";;
    esac
    exit 0;;
esac
exit 0
`;

describe.skipIf(process.platform === "win32")("diagnostic des conteneurs d'agents, avec un faux docker", () => {
  let dir = "";
  let dataDir = "";
  const saved = { ...process.env };
  const read = (name: string) => readFileSync(path.join(dir, name), "utf8");
  const has = (name: string) => existsSync(path.join(dir, name));
  const put = (name: string, content = "") => writeFileSync(path.join(dir, name), content);

  const runtime = (over: Partial<Config["agentRuntime"]> = {}): Config["agentRuntime"] => ({
    mode: "docker",
    image: "mon-image:1",
    extraImages: [],
    memory: "1536m",
    cpus: 1,
    pids: 256,
    network: null,
    dockerBin: path.join(dir, "docker"),
    containerUser: "host",
    ...over,
  });
  const context = (over: Partial<RuntimeContext> = {}): RuntimeContext => ({ dataDir, agentAuth: "api", apiKeyConfigured: true, ...over });
  const byId = (checks: RuntimeCheck[], id: RuntimeCheck["id"]) => checks.find((c) => c.id === id);
  /** Lignes des arguments de chaque `docker run`, séparées par bloc. */
  const runs = () => read("runs.txt").split("----\n").filter(Boolean).map((block) => block.split("\n").filter(Boolean));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "diag-docker-"));
    dataDir = path.join(dir, "data");
    mkdirSync(dataDir);
    writeFileSync(path.join(dir, "docker"), FAKE_DOCKER);
    chmodSync(path.join(dir, "docker"), 0o755);
    put("info.txt", "28.0.0|[name=seccomp,profile=builtin name=cgroupns]");
    put("probe.txt", PROBE_OK);
    put("claude.txt", "2.1.0 (Claude Code)\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("hors du mode conteneur : rien à contrôler, docker n'est pas lancé", async () => {
    const res = await diagnoseAgentRuntime(runtime({ mode: "host" }), context());
    expect(res).toEqual({ mode: "host", ok: true, checks: [] });
    expect(has("info-calls.txt")).toBe(false);
  });

  it("tout va bien : sept contrôles réussis, conteneur d'essai aux options d'une vraie tâche, rien ne reste après", async () => {
    const res = await diagnoseAgentRuntime(runtime(), context());
    expect(res.mode).toBe("docker");
    expect(res.checks.map((c) => `${c.id}:${c.ok}`)).toEqual(["auth:true", "docker:true", "image:true", "write:true", "isolation:true", "limits:true", "claude:true"]);
    expect(res.ok).toBe(true);
    expect(byId(res.checks, "docker")?.detail).toContain("28.0.0");
    expect(byId(res.checks, "docker")?.detail).toContain("avec root");
    expect(byId(res.checks, "claude")?.detail).toContain("2.1.0");

    // Deux conteneurs d'essai (script d'essai, puis la CLI), avec les options de sécurité des agents
    const [probe, cli] = runs();
    expect(probe).toBeDefined();
    expect(cli).toBeDefined();
    for (const args of [probe!, cli!]) {
      expect(args).toContain("--read-only");
      expect(args).toContain("--cap-drop");
      expect(args).toContain("no-new-privileges");
      expect(args[args.indexOf("--memory") + 1]).toBe("1536m");
      expect(args[args.indexOf("--pids-limit") + 1]).toBe("256");
      expect(args[args.indexOf("--user") + 1]).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
      expect(args).toContain("mon-image:1");
      const mount = args[args.indexOf("--mount") + 1]!;
      expect(mount).toMatch(new RegExp(`^type=bind,src=${dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/diagnostic-[A-Za-z0-9]+,dst=/work$`));
    }
    expect(probe!.slice(probe!.indexOf("mon-image:1") + 1, probe!.indexOf("mon-image:1") + 3)).toEqual(["sh", "-c"]);
    expect(cli!.slice(cli!.indexOf("mon-image:1") + 1)).toEqual(["claude", "--version"]);

    // Chaque conteneur est supprimé sous son nom, le dossier d'essai aussi
    expect(read("rm-names.txt").split("\n").filter(Boolean)).toHaveLength(2);
    for (const n of read("rm-names.txt").split("\n").filter(Boolean)) expect(n).toMatch(/^ra-diag-[0-9a-f]{12}$/);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("jamais la clé API ni les secrets de l'outil dans l'environnement ou les arguments de docker", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-api-a-ne-pas-transmettre";
    process.env.SECRETS_MASTER_KEY = "cle-maitre-a-ne-pas-transmettre";
    await diagnoseAgentRuntime(runtime(), context());
    expect(read("env.txt")).not.toContain("cle-api-a-ne-pas-transmettre");
    expect(read("env.txt")).not.toContain("cle-maitre-a-ne-pas-transmettre");
    expect(read("runs.txt")).not.toContain("cle-api-a-ne-pas-transmettre");
  });

  it("Docker sans root détecté : conteneur d'essai en root du conteneur, annoncé comme tel", async () => {
    put("info.txt", "28.0.0|[name=seccomp,profile=builtin name=rootless name=cgroupns]");
    const res = await diagnoseAgentRuntime(runtime({ containerUser: "auto" }), context());
    expect(byId(res.checks, "docker")?.detail).toContain("sans root");
    expect(runs()[0]![runs()[0]!.indexOf("--user") + 1]).toBe("0:0");
  });

  it("mode abonnement ou clé absente : le contrôle de connexion échoue et dit pourquoi, la suite est quand même vérifiée", async () => {
    const sub = await diagnoseAgentRuntime(runtime(), context({ agentAuth: "subscription" }));
    expect(byId(sub.checks, "auth")).toMatchObject({ ok: false, detail: expect.stringContaining("mode « Clé API »") });
    expect(sub.ok).toBe(false);
    expect(sub.checks.length).toBe(7);

    const noKey = await diagnoseAgentRuntime(runtime(), context({ apiKeyConfigured: false }));
    expect(byId(noKey.checks, "auth")).toMatchObject({ ok: false, detail: expect.stringContaining("aucune clé") });
  });

  it("Docker injoignable : erreur lisible, aucun conteneur lancé", async () => {
    put("info-fails");
    const res = await diagnoseAgentRuntime(runtime(), context());
    expect(res.ok).toBe(false);
    expect(res.checks.map((c) => c.id)).toEqual(["auth", "docker"]);
    expect(byId(res.checks, "docker")?.detail).toContain("Cannot connect to the Docker daemon");
    expect(has("runs.txt")).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("commande docker introuvable : même erreur lisible", async () => {
    const res = await diagnoseAgentRuntime(runtime({ dockerBin: path.join(dir, "absent") }), context());
    expect(byId(res.checks, "docker")).toMatchObject({ ok: false, detail: expect.stringContaining("Impossible d'interroger Docker") });
  });

  it("image absente : dit comment la construire, aucun conteneur lancé", async () => {
    put("image-missing");
    const res = await diagnoseAgentRuntime(runtime(), context());
    expect(res.checks.map((c) => c.id)).toEqual(["auth", "docker", "image"]);
    expect(byId(res.checks, "image")).toMatchObject({ ok: false });
    expect(byId(res.checks, "image")?.detail).toContain("mon-image:1");
    expect(byId(res.checks, "image")?.detail).toContain("Dockerfile.agent");
    expect(has("runs.txt")).toBe(false);
  });

  it("dossier de travail non inscriptible : désigne AGENT_CONTAINER_USER", async () => {
    put("probe.txt", PROBE_OK.replace("write=ok", "write=ko"));
    const res = await diagnoseAgentRuntime(runtime(), context());
    expect(byId(res.checks, "write")).toMatchObject({ ok: false, detail: expect.stringContaining("AGENT_CONTAINER_USER=root") });
    expect(byId(res.checks, "isolation")?.ok).toBe(true);
    expect(res.ok).toBe(false);
  });

  it("isolation insuffisante : chaque défaut est nommé", async () => {
    put("probe.txt", PROBE_OK.replace("root=ok", "root=ko").replace("caps=0000000000000000", "caps=00000000a80425fb").replace("nnp=1", "nnp=0"));
    const res = await diagnoseAgentRuntime(runtime(), context());
    const detail = byId(res.checks, "isolation")!.detail;
    expect(byId(res.checks, "isolation")?.ok).toBe(false);
    expect(detail).toContain("système de fichiers en écriture");
    expect(detail).toContain("capacités Linux conservées (00000000a80425fb)");
    expect(detail).toContain("élévation de droits possible");
  });

  it("plafonds ignorés par Docker (sans délégation de cgroups) : dit quoi faire ; plafond différent : le dit aussi", async () => {
    put("probe.txt", PROBE_OK.replace("mem=1610612736", "mem=max").replace("pids=256", "pids=max"));
    const ignored = byId((await diagnoseAgentRuntime(runtime(), context())).checks, "limits")!;
    expect(ignored.ok).toBe(false);
    expect(ignored.detail).toContain("plafond ignoré par Docker");
    expect(ignored.detail).toContain("section 11");

    put("probe.txt", PROBE_OK.replace("mem=1610612736", "mem=1000").replace("pids=256", "pids="));
    const wrong = byId((await diagnoseAgentRuntime(runtime(), context())).checks, "limits")!;
    expect(wrong.detail).toContain("mémoire : lu 1000 octets, attendu 1610612736 octets");
    expect(wrong.detail).toContain("processus : plafond ignoré par Docker (lu : indisponible");
  });

  it("le plafond de mémoire attendu suit le réglage (2g = 2 147 483 648 octets)", async () => {
    put("probe.txt", PROBE_OK.replace("mem=1610612736", "mem=2147483648"));
    const res = await diagnoseAgentRuntime(runtime({ memory: "2g" }), context());
    expect(byId(res.checks, "limits")?.ok).toBe(true);
  });

  it("conteneur d'essai qui ne démarre pas : la raison est donnée", async () => {
    put("probe-fails");
    const res = await diagnoseAgentRuntime(runtime(), context());
    expect(byId(res.checks, "write")).toMatchObject({ ok: false, label: "Conteneur d'essai", detail: expect.stringContaining("cannot start the container") });
    expect(byId(res.checks, "isolation")).toBeUndefined();
  });

  it("CLI Claude absente de l'image : le dit, les autres contrôles restent verts", async () => {
    put("claude-fails");
    const res = await diagnoseAgentRuntime(runtime(), context());
    expect(byId(res.checks, "claude")).toMatchObject({ ok: false, detail: expect.stringContaining("claude: not found") });
    expect(res.checks.filter((c) => c.ok)).toHaveLength(6);
    expect(res.ok).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
