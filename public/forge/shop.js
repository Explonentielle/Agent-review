/* Marchand de la forge : stock du jour tiré au hasard, prix d'achat et de revente.
   Logique pure (aucun DOM) : le navigateur l'utilise (items.js, popups.js), les tests la font jouer sans écran.
   Le stock dépend du jour et du « sel » de la sauvegarde : le même toute la journée, différent le lendemain, et chaque arme est unique
   (ses valeurs viennent de `rollWeapon`, voir combat.js). L'or et le sac sont dans le navigateur : aucune table, aucune route. */
(() => {
  "use strict";

  const RARITIES = ["common", "rare", "epic", "legendary"];
  /** Prix d'achat de base par rareté (une arme varie de 0,7 à 1,5 fois selon la qualité de son jet, une tenue vaut 0,6 fois). */
  const PRICE = { common: 80, rare: 220, epic: 520, legendary: 1200 };
  /** Chances de chaque rareté dans le stock, sur 100 (commun, rare, épique, légendaire). */
  const WEIGHTS = [45, 33, 16, 6];
  /** Le marchand rachète à 40 % de ce qu'il vend : acheter puis revendre ne rapporte jamais. */
  const SELL_RATE = 0.4;
  const WEAPON_COUNT = 4, COSMETIC_COUNT = 3;

  /** Le jour local, sous la forme « 2026-11-17 » (le stock change à minuit, heure du navigateur). */
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  /**
   * Valeur d'un objet, sa rareté et, pour une arme, la qualité de son jet.
   * @param item { kind, rarity }
   * @param quality Qualité du jet de l'arme (0 à 1) ; absente : valeur moyenne.
   * @returns Le prix d'achat chez le marchand.
   */
  function worth(item, quality) {
    const base = PRICE[item.rarity] ?? PRICE.common;
    if (item.kind === "weapon") return Math.round(base * (0.7 + 0.8 * (Number.isFinite(quality) ? Math.min(1, Math.max(0, quality)) : 0.5)));
    return Math.round(base * 0.6);
  }
  /** Ce que le marchand paie pour racheter un objet. */
  const sellPrice = (item, quality) => Math.max(1, Math.round(worth(item, quality) * SELL_RATE));

  /**
   * Le stock du jour : quelques armes uniques et quelques tenues, tirées au hasard dans le butin du catalogue.
   * @param salt Texte propre à cette sauvegarde (le stock n'est pas le même pour tout le monde).
   * @param day Jour (voir `dayKey`).
   * @param catalog Objets du butin (le catalogue du serveur) : { id, kind, rarity, weapon?, part? }.
   * @returns Des offres { offerId, itemId, kind, rarity, quality, price }. Le même (salt, jour, catalogue) donne toujours le même stock.
   */
  function offers(salt, day, catalog) {
    const C = globalThis.ForgeCombat, rnd = C.seededRandom(`shop|${salt}|${day}`);
    const weapons = catalog.filter((i) => i.kind === "weapon"), tenues = catalog.filter((i) => i.kind !== "weapon");
    const pickRarity = () => {
      let r = rnd() * 100;
      for (let i = 0; i < RARITIES.length; i++) { if (r < WEIGHTS[i]) return RARITIES[i]; r -= WEIGHTS[i]; }
      return "common";
    };
    const out = [];
    for (let i = 0; i < WEAPON_COUNT; i++) {
      const rarity = pickRarity(), pool = weapons.filter((w) => w.rarity === rarity);
      if (!pool.length) continue;
      const base = pool[Math.floor(rnd() * pool.length)], seed = `shop-${salt}-${day}-${i}`;
      const roll = C.rollWeapon(base.weapon, rarity, seed);
      out.push({ offerId: `w${i}`, itemId: `${base.id}#${seed}`, kind: "weapon", rarity, quality: roll ? roll.quality : 0.5, price: worth({ kind: "weapon", rarity }, roll ? roll.quality : 0.5) });
    }
    const taken = new Set();
    for (let i = 0; i < COSMETIC_COUNT; i++) {
      const rarity = pickRarity(), pool = tenues.filter((t) => t.rarity === rarity && !taken.has(t.id));
      if (!pool.length) continue;
      const base = pool[Math.floor(rnd() * pool.length)];
      taken.add(base.id); // pas deux fois la même tenue dans le stock
      out.push({ offerId: `c${i}`, itemId: base.id, kind: "cosmetic", rarity, quality: null, price: worth({ kind: "cosmetic", rarity }) });
    }
    return out;
  }

  globalThis.ForgeShop = { RARITIES, PRICE, WEIGHTS, SELL_RATE, WEAPON_COUNT, COSMETIC_COUNT, dayKey, worth, sellPrice, offers };
})();
