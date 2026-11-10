import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keyring, SecretError, envelopeKeyId, open, parseKey, seal } from "./crypto.js";

const newKey = () => randomBytes(32);
const CONTEXT = "review-agent:secret:1:2:github.token";

describe("chiffrement AES-256-GCM des secrets", () => {
  it("aller-retour : la valeur revient telle quelle, y compris accents et caractères spéciaux", () => {
    const keyring = new Keyring([newKey()]);
    for (const value of ["ghp_abc123", "été ☃ \"guillemets\" \\ et retour\nligne", "x".repeat(8000)]) {
      expect(open(keyring, seal(keyring, value, CONTEXT), CONTEXT)).toBe(value);
    }
  });

  it("l'enveloppe ne contient pas la valeur, et deux chiffrements du même secret diffèrent", () => {
    const keyring = new Keyring([newKey()]);
    const a = seal(keyring, "jeton-tres-secret", CONTEXT);
    const b = seal(keyring, "jeton-tres-secret", CONTEXT);
    expect(a).toMatch(/^v1:[0-9a-f]{8}:[\w-]+:[\w-]+:[\w-]+$/);
    expect(a).not.toContain("jeton-tres-secret");
    expect(Buffer.from(a.split(":")[4]!, "base64url").toString("utf8")).not.toContain("jeton");
    expect(a).not.toBe(b); // vecteur d'initialisation aléatoire
  });

  it("un autre contexte (autre espace, utilisateur ou nom) ne déchiffre pas", () => {
    const keyring = new Keyring([newKey()]);
    const envelope = seal(keyring, "valeur", CONTEXT);
    for (const other of ["review-agent:secret:9:2:github.token", "review-agent:secret:1:3:github.token", "review-agent:secret:1:2:anthropic.api_key", ""]) {
      expect(() => open(keyring, envelope, other)).toThrow(SecretError);
    }
  });

  it("une enveloppe modifiée (donnée, étiquette d'authentification, vecteur) est refusée", () => {
    const keyring = new Keyring([newKey()]);
    const [version, id, iv, tag, data] = seal(keyring, "valeur", CONTEXT).split(":") as [string, string, string, string, string];
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      return bytes.toString("base64url");
    };
    for (const tampered of [
      [version, id, iv, tag, flip(data)],
      [version, id, iv, flip(tag), data],
      [version, id, flip(iv), tag, data],
      [version, id, iv, tag.slice(0, -4), data],
    ]) {
      expect(() => open(keyring, tampered.join(":"), CONTEXT)).toThrow(/illisible/);
    }
  });

  it("une autre clé, un format inconnu ou un texte quelconque donnent une erreur sans fuite", () => {
    const keyring = new Keyring([newKey()]);
    const envelope = seal(keyring, "valeur-secrete", CONTEXT);
    const stranger = new Keyring([newKey()]);
    expect(() => open(stranger, envelope, CONTEXT)).toThrow(/clé maître qui l'a chiffré n'est pas disponible/);
    expect(() => open(keyring, envelope.replace("v1:", "v2:"), CONTEXT)).toThrow(/format inconnu/);
    expect(() => open(keyring, "n'importe quoi", CONTEXT)).toThrow(/format inconnu/);
    try {
      open(stranger, envelope, CONTEXT);
    } catch (err) {
      expect((err as Error).message).not.toContain("valeur-secrete");
    }
  });

  it("rotation : l'ancienne clé déchiffre encore, la nouvelle chiffre, l'identifiant dit laquelle a servi", () => {
    const oldKey = newKey();
    const next = newKey();
    const before = seal(new Keyring([oldKey]), "ancien", CONTEXT);
    const rotated = new Keyring([next, oldKey]);
    expect(open(rotated, before, CONTEXT)).toBe("ancien");
    const after = seal(rotated, "nouveau", CONTEXT);
    expect(envelopeKeyId(after)).toBe(rotated.currentKeyId);
    expect(envelopeKeyId(before)).not.toBe(rotated.currentKeyId);
    expect(envelopeKeyId("pas une enveloppe")).toBeNull();
    // sans l'ancienne clé, l'ancien secret n'est plus lisible
    expect(() => open(new Keyring([next]), before, CONTEXT)).toThrow(/n'est pas disponible/);
  });

  it("clé maître : 32 octets en base64 exigés, message sans la clé", () => {
    const good = randomBytes(32).toString("base64");
    expect(parseKey(` ${good}\n`)).toHaveLength(32);
    expect(parseKey(randomBytes(32).toString("base64url"))).toHaveLength(32);
    for (const bad of ["", "court", randomBytes(16).toString("base64"), randomBytes(48).toString("base64"), "pas du base64 !!!"]) {
      expect(() => parseKey(bad)).toThrow(/32 octets/);
    }
    try {
      parseKey("mot-de-passe-trop-court");
    } catch (err) {
      expect((err as Error).message).not.toContain("mot-de-passe");
    }
    expect(() => new Keyring([])).toThrow(SecretError);
    expect(() => new Keyring([randomBytes(16)])).toThrow(SecretError);
  });
});
