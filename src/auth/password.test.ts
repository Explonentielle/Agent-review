import { describe, expect, it } from "vitest";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PasswordError, checkPassword, hashPassword, spendVerificationTime, verifyPassword } from "./password.js";

describe("mots de passe", () => {
  it("une empreinte ne contient pas le mot de passe, change à chaque calcul et se vérifie", async () => {
    const a = await hashPassword("une phrase de passe longue");
    const b = await hashPassword("une phrase de passe longue");
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toContain("phrase");
    expect(a).not.toBe(b); // sel propre à chaque mot de passe
    expect(await verifyPassword("une phrase de passe longue", a)).toBe(true);
    expect(await verifyPassword("une phrase de passe longue", b)).toBe(true);
  });

  it("refuse un autre mot de passe, y compris à une lettre près", async () => {
    const hash = await hashPassword("une phrase de passe longue");
    expect(await verifyPassword("une phrase de passe longuE", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("la forme Unicode ne change rien : le même mot de passe saisi avec un accent composé ou décomposé passe", async () => {
    const hash = await hashPassword("mot de passe é long");
    expect(await verifyPassword("mot de passe é long", hash)).toBe(true); // « é » composé contre « e » + accent
  });

  it("une empreinte illisible ou aux coûts démesurés est refusée sans calcul", async () => {
    for (const stored of ["", "abc", "bcrypt$1$2$3$4$5", "scrypt$32768$8$1$sel", "scrypt$99999999$8$1$c2Vs$Y2zDqQ", "scrypt$32768$999$1$c2Vs$Y2zDqQ", "scrypt$x$8$1$c2Vs$Y2zDqQ"]) {
      expect(await verifyPassword("n'importe quoi", stored), stored).toBe(false);
    }
  });

  it("la règle : longueur entre 10 et 200, jamais l'adresse email, aucune règle de composition", () => {
    expect(() => checkPassword("court", "a@b.fr")).toThrow(PasswordError);
    expect(() => checkPassword("x".repeat(MIN_PASSWORD_LENGTH - 1), "a@b.fr")).toThrow(/au moins/);
    expect(() => checkPassword("x".repeat(MAX_PASSWORD_LENGTH + 1), "a@b.fr")).toThrow(/au plus/);
    expect(() => checkPassword("Alice@Example.com", "alice@example.com")).toThrow(/adresse email/);
    expect(() => checkPassword("aaaaaaaaaa", "a@b.fr")).not.toThrow(); // pas de majuscule ni de chiffre exigés
    expect(() => checkPassword("x".repeat(MAX_PASSWORD_LENGTH), "a@b.fr")).not.toThrow();
  });

  it("dépenser le temps d'une vérification ne plante pas et ne valide rien", async () => {
    await expect(spendVerificationTime("quelque chose")).resolves.toBeUndefined();
  });
});
