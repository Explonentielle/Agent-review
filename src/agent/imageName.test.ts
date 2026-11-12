import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { ProjectSettingsSchema } from "../settings/schema.js";
import { IMAGE_NAME_RE, allowedImages, imageFor } from "./imageName.js";

const RUNTIME = { image: "review-agent-sandbox:local", extraImages: ["agent-php73:1", "registre.local:5000/equipe/agent-php84:2"] };

describe("noms d'images d'agents", () => {
  it("accepte noms, registres avec port, étiquettes et empreintes ; refuse ce que docker lirait comme une option ou un second argument", () => {
    for (const ok of ["php", "review-agent-sandbox:local", "registre.local:5000/equipe/agent:7.3", "ghcr.io/org/img@sha256:" + "a".repeat(64), "A1_b.c-d"]) {
      expect(IMAGE_NAME_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["", "-privileged", "--rm", " php", "php 7", "php;ls", "a\nb", "a$(b)", "image,src=/etc", "x".repeat(201)]) {
      expect(IMAGE_NAME_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("images autorisées : l'image par défaut en premier, sans doublon", () => {
    expect(allowedImages(RUNTIME)).toEqual(["review-agent-sandbox:local", "agent-php73:1", "registre.local:5000/equipe/agent-php84:2"]);
    expect(allowedImages({ image: "a:1", extraImages: ["a:1", "b:1", "b:1"] })).toEqual(["a:1", "b:1"]);
  });

  it("image d'un projet : vide ou absente = par défaut, une image autorisée est reprise, les autres sont refusées", () => {
    expect(imageFor(RUNTIME, "")).toBe("review-agent-sandbox:local");
    expect(imageFor(RUNTIME, "   ")).toBe("review-agent-sandbox:local");
    expect(imageFor(RUNTIME, undefined)).toBe("review-agent-sandbox:local");
    expect(imageFor(RUNTIME, null)).toBe("review-agent-sandbox:local");
    expect(imageFor(RUNTIME, "agent-php73:1")).toBe("agent-php73:1");
    expect(imageFor(RUNTIME, " agent-php73:1 ")).toBe("agent-php73:1");
    expect(imageFor(RUNTIME, "review-agent-sandbox:local")).toBe("review-agent-sandbox:local");
    expect(() => imageFor(RUNTIME, "postgres:16-alpine")).toThrow(/non autorisée.*AGENT_IMAGES/);
    expect(() => imageFor(RUNTIME, "agent-php73")).toThrow(/non autorisée/); // sans l'étiquette : ce n'est pas la même image
  });
});

describe("configuration des images d'agents", () => {
  const base = { GITHUB_TOKEN: "github_pat_ENV_123456", DATA_DIR: "/tmp/x" };

  it("AGENT_IMAGES : séparées par des virgules ou des espaces, vide = aucune", () => {
    expect(loadConfig(base).agentRuntime.extraImages).toEqual([]);
    expect(loadConfig({ ...base, AGENT_IMAGES: "" }).agentRuntime.extraImages).toEqual([]);
    expect(loadConfig({ ...base, AGENT_IMAGES: "agent-php73:1, agent-php84:2 agent-node:3" }).agentRuntime.extraImages).toEqual(["agent-php73:1", "agent-php84:2", "agent-node:3"]);
  });

  it("noms d'images invalides refusés au démarrage, dans AGENT_IMAGE comme dans AGENT_IMAGES", () => {
    expect(() => loadConfig({ ...base, AGENT_IMAGE: "--privileged" })).toThrow(/AGENT_IMAGE/);
    expect(() => loadConfig({ ...base, AGENT_IMAGE: "image avec espace" })).toThrow(/AGENT_IMAGE/);
    expect(() => loadConfig({ ...base, AGENT_IMAGES: "bon:1,-mauvais" })).toThrow(/AGENT_IMAGES/);
    expect(() => loadConfig({ ...base, AGENT_IMAGES: Array.from({ length: 51 }, (_, i) => `i${i}`).join(",") })).toThrow(/AGENT_IMAGES/);
  });
});

describe("image d'agent dans les réglages d'un projet", () => {
  const project = { source: "gitlab", projectId: 1, path: "g/p", devEnabled: false, baseBranch: "", targetBranch: "", allowedCommands: [], instructions: "" };

  it("absente des réglages enregistrés avant son arrivée : image par défaut ; sinon nettoyée et validée", () => {
    expect(ProjectSettingsSchema.parse(project).agentImage).toBe("");
    expect(ProjectSettingsSchema.parse({ ...project, agentImage: "  agent-php73:1 " }).agentImage).toBe("agent-php73:1");
    expect(ProjectSettingsSchema.parse({ ...project, agentImage: "" }).agentImage).toBe("");
    expect(() => ProjectSettingsSchema.parse({ ...project, agentImage: "-x" })).toThrow(/nom d'image invalide/);
    expect(() => ProjectSettingsSchema.parse({ ...project, agentImage: "a b" })).toThrow(/nom d'image invalide/);
  });
});
