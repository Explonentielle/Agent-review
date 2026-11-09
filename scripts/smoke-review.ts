/**
 * Test réel de l'exécuteur de review (CliRunner + runReviewAgent), sur un dépôt jetable : aucun
 * GitLab, aucun push. Haiku en effort faible pour consommer un minimum de quota.
 * Vérifie : les options de la CLI sont acceptées, la sortie structurée est lue, un bug évident est
 * trouvé, et l'isolation tient (le hook piégé du dépôt n'est PAS exécuté grâce à --safe-mode).
 * Usage : npx tsx scripts/smoke-review.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CliRunner } from "../src/agent/index.js";
import { runReviewAgent } from "../src/review/engine.js";

const dir = mkdtempSync(path.join(tmpdir(), "smoke-review-"));
const trap = path.join(dir, "HOOK_RAN");
writeFileSync(path.join(dir, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
mkdirSync(path.join(dir, ".claude"));
// Hook piège : s'il s'exécute, --safe-mode ne protège pas
writeFileSync(
  path.join(dir, ".claude", "settings.json"),
  JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${trap}` }] }] } }),
);

const claudeBin = existsSync(path.join(homedir(), ".local/bin/claude")) ? path.join(homedir(), ".local/bin/claude") : "claude";

try {
  const out = await runReviewAgent({
    cwd: dir,
    systemPrompt: "Tu relis le code d'une merge request fictive. Réponds via la sortie structurée.",
    prompt: "Lis math.js. La fonction add doit additionner deux nombres. Relève le bug éventuel avec sa localisation.",
    engine: { model: "claude-haiku-4-5", effort: "low", maxTurns: 10, timeoutMs: 3 * 60_000 },
    runner: new CliRunner(claudeBin),
  });

  const found = out.result.findings.length > 0;
  console.log("--- Résultat ---\n" + JSON.stringify(out.result, null, 2));
  console.log("\n--- Vérifications ---");
  console.log(`options acceptées, sortie lue : OK`);
  console.log(`bug trouvé                     : ${found ? "OK" : "aucun point relevé"}`);
  console.log(`hook du dépôt non exécuté      : ${existsSync(trap) ? "ÉCHEC : HOOK EXÉCUTÉ, DANGER" : "OK"}`);
  console.log(`tours / coût équivalent        : ${out.numTurns} / ${out.costUsd?.toFixed(4)} $`);
  if (existsSync(trap)) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
