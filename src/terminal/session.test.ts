import { afterEach, describe, expect, it } from "vitest";
import { TerminalError, TerminalHub, TerminalSession, type TerminalEvent, type TerminalLaunch, type TerminalLimits } from "./session.js";

/** Faux programme : renvoie « echo:<saisie> », et s'arrête sur « q ». Aucun vrai terminal n'est nécessaire. */
const ECHO = "process.stdin.on('data', (d) => { const s = String(d); process.stdout.write('echo:' + s); if (s.trim() === 'q') process.exit(3); }); setInterval(() => {}, 1000);";
const launchOf = (script = ECHO): TerminalLaunch => ({ file: process.execPath, args: ["-e", script], env: { ...process.env }, cwd: process.cwd() });
const LIMITS: TerminalLimits = { idleMs: 60_000, maxMs: 60_000, backlogBytes: 1024, maxInputChars: 20 };

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function collect(session: TerminalSession) {
  const events: TerminalEvent[] = [];
  const unsubscribe = session.subscribe((e) => events.push(e));
  const text = () => events.filter((e): e is Extract<TerminalEvent, { type: "data" }> => e.type === "data").map((e) => e.data.toString()).join("");
  return { events, text, unsubscribe };
}

describe("session de terminal", () => {
  const opened: TerminalSession[] = [];
  const open = (limits = LIMITS, launch = launchOf()) => {
    const s = new TerminalSession(launch, limits);
    opened.push(s);
    return s;
  };
  afterEach(() => {
    for (const s of opened.splice(0)) s.stop();
  });

  it("envoie la saisie au programme et diffuse sa sortie", async () => {
    const session = open();
    const out = collect(session);
    session.write("bonjour");
    await waitFor(() => out.text().includes("echo:bonjour"));
    expect(session.alive).toBe(true);
  });

  it("nettoie à la fin de la session, une seule fois : sortie du programme comme arrêt, même si le nettoyage échoue", async () => {
    let calls = 0;
    const exited = open(LIMITS, { ...launchOf("process.exit(0)"), cleanup: async () => void (calls += 1) });
    await waitFor(() => !exited.alive);
    await waitFor(() => calls === 1);
    const stopped = open(LIMITS, {
      ...launchOf(),
      cleanup: async () => {
        calls += 10;
        throw new Error("nettoyage en échec");
      },
    });
    expect(calls).toBe(1); // rien tant que la session vit
    stopped.stop();
    await waitFor(() => !stopped.alive);
    await waitFor(() => calls === 11);
    stopped.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(11);
  });

  it("un abonné tardif reçoit d'abord la sortie déjà produite", async () => {
    const session = open();
    const first = collect(session);
    session.write("un");
    await waitFor(() => first.text().includes("echo:un"));
    const late = collect(session);
    expect(late.text()).toContain("echo:un");
    session.write("deux");
    await waitFor(() => late.text().includes("echo:deux"));
  });

  it("la sortie gardée est bornée", async () => {
    const session = open({ ...LIMITS, backlogBytes: 30 }, launchOf("for (let i = 0; i < 20; i++) process.stdout.write('ligne-' + i + '\\n'); setInterval(() => {}, 1000);"));
    await waitFor(() => collect(session).text().includes("ligne-19"));
    const kept = collect(session).text();
    expect(kept.includes("ligne-0\n")).toBe(false);
    expect(kept).toContain("ligne-19");
  });

  it("la sortie gardée ne dépasse jamais la limite, même quand tout arrive d'un seul bloc", async () => {
    // Un seul write : un seul bloc de 103 octets, quel que soit le découpage du tube (avant, il était gardé entier)
    const session = open({ ...LIMITS, backlogBytes: 30 }, launchOf("process.stdout.write('A'.repeat(100) + 'FIN'); setInterval(() => {}, 1000);"));
    await waitFor(() => collect(session).text().includes("FIN"));
    const kept = collect(session).text();
    expect(Buffer.byteLength(kept)).toBe(30);
    expect(kept.endsWith("AAAFIN")).toBe(true);
    // Les blocs suivants continuent de repousser les plus vieux octets
    const later = open({ ...LIMITS, backlogBytes: 10 }, launchOf("process.stdout.write('0123456789'); setTimeout(() => process.stdout.write('abcdef'), 50); setInterval(() => {}, 1000);"));
    await waitFor(() => collect(later).text().includes("abcdef"));
    expect(collect(later).text()).toBe("6789abcdef");
  });

  it("signale la fin du programme avec son code, puis refuse la saisie", async () => {
    const session = open();
    const out = collect(session);
    session.write("q");
    await waitFor(() => out.events.some((e) => e.type === "exit"));
    expect(out.events.at(-1)).toEqual({ type: "exit", code: 3 });
    expect(session.alive).toBe(false);
    expect(() => session.write("x")).toThrow(TerminalError);
    // Qui se rattache après la fin voit la sortie puis la fin
    const after = collect(session);
    expect(after.events.at(-1)).toEqual({ type: "exit", code: 3 });
  });

  it("refuse une saisie trop longue sans la transmettre", async () => {
    const session = open();
    const out = collect(session);
    expect(() => session.write("x".repeat(21))).toThrow(/trop longue/);
    session.write("ok");
    await waitFor(() => out.text().includes("echo:ok"));
    expect(out.text().includes("xxxx")).toBe(false);
  });

  it("se ferme seule après un temps sans saisie", async () => {
    const session = open({ ...LIMITS, idleMs: 150 });
    await waitFor(() => !session.alive, 8000);
    expect(session.alive).toBe(false);
  });

  it("un programme introuvable termine la session avec un message lisible", async () => {
    const session = open(LIMITS, { file: "programme-qui-n-existe-pas-xyz", args: [], env: {}, cwd: process.cwd() });
    const out = collect(session);
    await waitFor(() => out.events.some((e) => e.type === "exit"));
    expect(out.text()).toContain("Impossible de lancer le terminal");
    expect(session.alive).toBe(false);
  });
});

describe("sessions par personne", () => {
  it("en ouvrir une nouvelle ferme la précédente ; l'arrêt ne touche que la personne visée", async () => {
    const hub = new TerminalHub(LIMITS);
    const a1 = hub.start("1:1", launchOf());
    const b = hub.start("1:2", launchOf());
    expect(hub.get("1:1")).toBe(a1);

    const a2 = hub.start("1:1", launchOf());
    await waitFor(() => !a1.alive, 8000);
    expect(hub.get("1:1")).toBe(a2);
    expect(b.alive).toBe(true);

    expect(hub.stop("1:1")).toBe(true);
    await waitFor(() => !a2.alive, 8000);
    expect(hub.get("1:1")).toBeUndefined();
    expect(hub.stop("1:1")).toBe(false);

    hub.stopAll();
    await waitFor(() => !b.alive, 8000);
  });
});
