import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorMessage, initFileLogging, log, maskSecrets, registerSecret } from "./logger.js";

describe("journal : les secrets déclarés n'apparaissent jamais", () => {
  let dir: string;
  let printed: string[];
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "logger-"));
    initFileLogging(dir);
    printed = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void printed.push(line));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Contenu du fichier de journal du jour. */
  const fileContent = () => {
    const logs = path.join(dir, "logs");
    return readdirSync(logs).map((f) => readFileSync(path.join(logs, f), "utf8")).join("");
  };

  it("une valeur déclarée est remplacée dans la console et dans le fichier, y compris dans un objet imbriqué", () => {
    registerSecret("ghp_SECRET_A_MASQUER_123");
    log.info("test.event", { url: "https://x@api.example/?token=ghp_SECRET_A_MASQUER_123", nested: { value: "ghp_SECRET_A_MASQUER_123" } });
    log.error("test.error", { error: "échec avec ghp_SECRET_A_MASQUER_123" });

    expect(printed).toHaveLength(2);
    for (const text of [...printed, fileContent()]) {
      expect(text).not.toContain("ghp_SECRET_A_MASQUER_123");
      expect(text).toContain("[secret]");
    }
    expect(JSON.parse(printed[0]!)).toMatchObject({ event: "test.event", nested: { value: "[secret]" } });
  });

  it("un secret avec des caractères échappés en JSON est masqué aussi", () => {
    registerSecret('mot"de\\passe/avec\nsaut');
    log.warn("test.escaped", { detail: 'mot"de\\passe/avec\nsaut' });
    expect(printed[0]).not.toContain("passe/avec");
    expect(fileContent()).not.toContain("passe/avec");
  });

  it("les messages d'erreur renvoyés à l'utilisateur sont masqués aussi", () => {
    registerSecret("sk-ant-CLE-DANS-UNE-ERREUR");
    expect(errorMessage(new Error("401 avec sk-ant-CLE-DANS-UNE-ERREUR refusée"))).toBe("401 avec [secret] refusée");
    expect(errorMessage("texte brut sk-ant-CLE-DANS-UNE-ERREUR")).toBe("texte brut [secret]");
    expect(maskSecrets("rien à masquer ici")).toBe("rien à masquer ici");
  });

  it("les valeurs trop courtes ou vides ne sont pas masquées (elles feraient disparaître des mots courants)", () => {
    registerSecret("abc");
    registerSecret("");
    registerSecret(null);
    registerSecret(undefined);
    expect(maskSecrets("abc def")).toBe("abc def");
  });
});
