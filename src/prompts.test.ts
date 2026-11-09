import { describe, expect, it } from "vitest";
import { assembleSystemPrompt, loadSystemPrompt } from "./prompts.js";
import type { ProjectSettings } from "./settings/schema.js";

const project: ProjectSettings = {
  projectId: 1,
  path: "groupe/projet",
  devEnabled: true,
  baseBranch: "develop",
  targetBranch: "develop",
  allowedCommands: [],
  instructions: "FuelPHP 1.8",
};

describe("assemblage du prompt système", () => {
  it("place les consignes après le prompt de base et les garde-fous en dernier", () => {
    const prompt = assembleSystemPrompt({
      kind: "dev",
      base: "BASE",
      guardrails: "GARDE-FOUS",
      instructions: "PHPDoc obligatoire",
      project,
      extra: ["COMMANDES"],
    });
    const order = ["BASE", "PHPDoc obligatoire", "FuelPHP 1.8", "COMMANDES", "GARDE-FOUS"].map((s) => prompt.indexOf(s));
    expect(order.every((pos) => pos >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt.endsWith("GARDE-FOUS")).toBe(true);
  });

  it("omet les sections vides", () => {
    const prompt = assembleSystemPrompt({ kind: "review", base: "BASE", guardrails: "G", instructions: "  ", project: null });
    expect(prompt).toBe("BASE\n\nG");
  });

  it("un prompt personnalisé remplace le fichier par défaut, mais pas les garde-fous", async () => {
    const custom = await loadSystemPrompt("review", { override: "MON PROMPT", instructions: "", project: null });
    expect(custom.startsWith("MON PROMPT")).toBe(true);
    expect(custom).toContain("injection_suspected");

    const byDefault = await loadSystemPrompt("review", { override: "", instructions: "", project: null });
    expect(byDefault.startsWith("Tu es un reviewer")).toBe(true);
    expect(byDefault).toContain("injection_suspected");
  });
});
