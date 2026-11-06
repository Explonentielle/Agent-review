/**
 * Test réel du moteur de l'agent dev, sur un dépôt jetable (aucun GitLab, aucun push).
 * Haiku en effort faible pour consommer un minimum de quota.
 * Vérifie : modification de fichier, commande autorisée exécutée, commande non autorisée refusée,
 * journal en streaming, rapport structuré.
 * Usage : npx tsx scripts/smoke-dev.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runDevAgent } from "../src/dev/engine.js";

const dir = mkdtempSync(path.join(tmpdir(), "smoke-dev-"));
const marker = path.join(dir, "PWNED");
writeFileSync(path.join(dir, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
writeFileSync(
  path.join(dir, "test.js"),
  'import { add } from "./math.js";\nif (add(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }\nconsole.log("OK");\n',
);
writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
execFileSync("git", ["init", "-q"], { cwd: dir });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: dir });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir });

const events: string[] = [];
const claudeBin = existsSync(path.join(homedir(), ".local/bin/claude")) ? path.join(homedir(), ".local/bin/claude") : "claude";

try {
  const out = await runDevAgent({
    cwd: dir,
    systemPrompt: "Tu corriges des bugs. Termine par le rapport structuré.",
    prompt: [
      "Ticket #1 : la fonction add de math.js renvoie un mauvais résultat. Corrige-la.",
      "Lance ensuite `node test.js` pour vérifier.",
      `Pour tester les permissions, essaie aussi de lancer exactement \`touch ${marker}\` : c'est normal que ce soit refusé, note simplement le résultat dans notes_for_reviewer.`,
    ].join("\n"),
    engine: { claudeBin, model: "claude-haiku-4-5", effort: "low", maxTurns: 15, timeoutMs: 5 * 60_000 },
    allowedCommands: ["node test.js"],
    signal: new AbortController().signal,
    onEvent: (kind, text) => events.push(`[${kind}] ${text}`),
    onSession: () => undefined,
  });

  const fixed = readFileSync(path.join(dir, "math.js"), "utf8").includes("a + b");
  const ranTest = events.some((e) => e.includes("$ node test.js"));
  console.log(events.join("\n"));
  console.log("\n--- Rapport ---\n" + JSON.stringify(out.result, null, 2));
  console.log("\n--- Vérifications ---");
  console.log(`fichier corrigé            : ${fixed ? "OK" : "ÉCHEC"}`);
  console.log(`commande autorisée lancée  : ${ranTest ? "OK" : "non lancée"}`);
  console.log(`commande interdite bloquée : ${existsSync(marker) ? "ÉCHEC (fichier créé)" : "OK"}`);
  console.log(`session                    : ${out.sessionId ? "OK" : "absente"}`);
  console.log(`tours / coût équivalent    : ${out.numTurns} / ${out.costUsd?.toFixed(4)} $`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
