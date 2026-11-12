import { describe, expect, it } from "vitest";
import { createClaudeStatusProbe, type StatusRunResult } from "./status.js";

function probe(results: StatusRunResult[], ttlMs = 30_000) {
  let clock = 1_000;
  const calls: string[][] = [];
  const run = async (_bin: string, args: string[]) => {
    calls.push(args);
    return results.shift() ?? { code: 1, stdout: "", stderr: "", missing: false };
  };
  return { probe: createClaudeStatusProbe("claude", () => ({}), run, ttlMs, () => clock), calls, advance: (ms: number) => (clock += ms) };
}

const ok = (stdout: string): StatusRunResult => ({ code: 0, stdout, stderr: "", missing: false });

describe("état de la connexion Claude", () => {
  it("connecté quand la CLI répond par un code 0, texte nettoyé des couleurs et tronqué", async () => {
    const { probe: p } = probe([ok(`\u001b[32mLogged in\u001b[0m as alex  via subscription\n${"x".repeat(500)}`)]);
    const status = await p.get();
    expect(status.installed).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.detail.startsWith("Logged in as alex via subscription")).toBe(true);
    expect(status.detail.length).toBe(300);
  });

  it("non connecté quand la CLI répond par un code d'erreur, introuvable quand le programme manque", async () => {
    expect((await probe([{ code: 1, stdout: "Not logged in", stderr: "", missing: false }]).probe.get()).connected).toBe(false);
    const missing = await probe([{ code: null, stdout: "", stderr: "", missing: true }]).probe.get();
    expect(missing).toMatchObject({ installed: false, connected: false, detail: "" });
  });

  it("garde le résultat pendant le délai, sauf si on le force ou s'il est oublié", async () => {
    const { probe: p, calls, advance } = probe([ok("un"), ok("deux"), ok("trois"), ok("quatre")], 30_000);
    expect((await p.get()).detail).toBe("un");
    advance(10_000);
    expect((await p.get()).detail).toBe("un");
    expect(calls.length).toBe(1);
    advance(21_000);
    expect((await p.get()).detail).toBe("deux");
    expect((await p.get(true)).detail).toBe("trois");
    p.forget();
    expect((await p.get()).detail).toBe("quatre");
  });

  it("des appels simultanés partagent un seul lancement de la CLI", async () => {
    const { probe: p, calls } = probe([ok("une seule fois")]);
    const [a, b] = await Promise.all([p.get(), p.get()]);
    expect(a).toBe(b);
    expect(calls.length).toBe(1);
  });

  it("interroge `claude auth status --text`", async () => {
    const { probe: p, calls } = probe([ok("ok")]);
    await p.get();
    expect(calls[0]).toEqual(["auth", "status", "--text"]);
  });
});
