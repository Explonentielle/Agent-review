import { describe, expect, it } from "vitest";
import { ALLOWED_EFFORTS, ALLOWED_MODELS, AgentSettingsSchema, DEFAULT_SETTINGS } from "./schema.js";

/* Modèles et efforts : une liste blanche d'IDs complets, et un défaut qui ne bouge pas (Sonnet 5.5, effort élevé). */
const base = { maxTurns: 40, timeoutMin: 20 };

describe("modèles et efforts choisissables", () => {
  it("chaque modèle et chaque effort de la liste est accepté", () => {
    for (const model of ALLOWED_MODELS) {
      for (const effort of ALLOWED_EFFORTS) {
        expect(AgentSettingsSchema.safeParse({ ...base, model, effort }).success).toBe(true);
      }
    }
  });

  it("la liste couvre les modèles actuels et les efforts de la CLI, jusqu'à xhigh et max", () => {
    expect([...ALLOWED_MODELS]).toEqual(expect.arrayContaining(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5"]));
    expect([...ALLOWED_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("un alias, un identifiant inconnu ou une option de ligne de commande est refusé", () => {
    for (const model of ["sonnet", "opus", "claude-opus", "claude-inconnu-9", "--dangerously-skip-permissions", ""]) {
      expect(AgentSettingsSchema.safeParse({ ...base, model, effort: "high" }).success).toBe(false);
    }
  });

  it("un effort inconnu est refusé", () => {
    for (const effort of ["ultra", "HIGH", "", "--max"]) {
      expect(AgentSettingsSchema.safeParse({ ...base, model: "claude-sonnet-5-5", effort }).success).toBe(false);
    }
  });

  it("le défaut des reviews et des tâches de dev reste Sonnet 5.5 en effort élevé", () => {
    expect(DEFAULT_SETTINGS.review).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    expect(DEFAULT_SETTINGS.dev).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
  });
});
