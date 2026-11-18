import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rateLimit.js";

describe("limiteur de tentatives", () => {
  it("laisse passer jusqu'à la limite, puis refuse avec le délai avant la prochaine tentative", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter(3, 60_000, () => t);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")].every((r) => r.ok)).toBe(true);
    t += 10_000;
    const refused = limiter.take("a");
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 50 }); // la plus ancienne tentative sort de la fenêtre dans 50 s
    t += 49_000;
    expect(limiter.take("a")).toMatchObject({ ok: false, retryAfterSeconds: 1 });
    t += 1_000;
    expect(limiter.take("a").ok).toBe(true); // la fenêtre a glissé : une place est libre
  });

  it("les tentatives refusées ne comptent pas (on ne s'enferme pas soi-même plus longtemps)", () => {
    let t = 0;
    const limiter = createRateLimiter(1, 1_000, () => t);
    limiter.take("a");
    for (let i = 0; i < 50; i++) { t += 10; expect(limiter.take("a").ok).toBe(false); }
    t = 1_001;
    expect(limiter.take("a").ok).toBe(true);
  });

  it("chaque clé a sa propre limite, et reset oublie tout", () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("b").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
    limiter.reset();
    expect(limiter.take("a").ok).toBe(true);
  });

  it("la mémoire est bornée : au-delà de 10 000 clés, les plus anciennes sont oubliées", () => {
    const limiter = createRateLimiter(1, 3_600_000);
    for (let i = 0; i < 10_050; i++) limiter.take(`ip-${i}`);
    expect(limiter.take("ip-0").ok).toBe(true); // oubliée : repart de zéro
    expect(limiter.take("ip-10049").ok).toBe(false); // récente : encore suivie
  });
});
