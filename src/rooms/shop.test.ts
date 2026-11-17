import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { LOOT_CATALOG } from "../game/loot.js";
import { PROJECT_ROOT } from "../paths.js";

/* Le marchand : stock du jour tiré au hasard (`public/forge/shop.js`), et achat et vente des objets du sac (`public/forge/items.js`), joués sans écran. */
interface Offer { offerId: string; itemId: string; kind: string; rarity: string; quality: number | null; price: number }
interface Shop {
  RARITIES: string[];
  PRICE: Record<string, number>;
  WEIGHTS: number[];
  SELL_RATE: number;
  dayKey(d?: Date): string;
  worth(item: { kind: string; rarity: string }, quality?: number): number;
  sellPrice(item: { kind: string; rarity: string }, quality?: number): number;
  offers(salt: string, day: string, catalog: unknown[]): Offer[];
}
interface Combat { rollWeapon(type: string, rarity: string, seed: string): { quality: number } }
interface Item { id: string; name: string; kind: string; rarity: string; rank?: string; unique?: boolean }
interface ShopOffer extends Offer { item: Item; bought: boolean }
interface Items {
  migrate(): void;
  add(id: string, src: string): void;
  equip(id: string): boolean;
  unequip(part: string): void;
  owns(id: string): boolean;
  count(id: string): number;
  catalog(): Map<string, Item>;
  remove(id: string): boolean;
  shopOffers(): ShopOffer[];
  buyOffer(id: string): { ok: boolean; why?: string; item?: Item; price?: number };
  sellable(): Array<{ item: Item; copies: number; price: number }>;
  sellItem(id: string): { item: Item; price: number } | null;
}
interface Save { gold: number; items: Record<string, { n: number; from: Record<string, number> }>; owned: string[]; equip: Record<string, string | null>; fresh: string[]; looted: string[]; shop?: { day: string; bought: string[]; salt: string } }

function load() {
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const run = (file: string) => vm.runInContext(readFileSync(path.join(PROJECT_ROOT, "public", "forge", file), "utf8"), context, { filename: file, timeout: 2000 });
  run("combat.js");
  run("shop.js");
  sandbox.ForgeSprites = { GRADE: { common: { name: "Commun", c: "#999" }, rare: { name: "Rare", c: "#46f" }, epic: { name: "Épique", c: "#a6f" }, legendary: { name: "Légendaire", c: "#fb2" } } };
  sandbox.esc = (t: unknown) => String(t);
  run("items.js");
  return { Shop: sandbox.ForgeShop as Shop, Combat: sandbox.ForgeCombat as Combat, ForgeItems: sandbox.ForgeItems as { create(g: unknown, ctx: unknown): Items } };
}
const { Shop, Combat, ForgeItems } = load();
const CATALOG = LOOT_CATALOG as unknown as Array<{ id: string; kind: string; rarity: string; weapon?: string }>;

/** Un sac neuf, avec le catalogue du butin et une tenue de prestige dans la boutique fixe. */
function bag(gold = 5000) {
  const save: Save = { gold, items: {}, owned: [], equip: { cape: null, hat: null, apron: null, weapon: null }, fresh: [], looted: [] };
  const baseItems = [{ id: "cape-rouge", rarity: "common", name: "Cape rouge", part: "cape", value: "#b0302e" }, { id: "cape-orichalque", rarity: "legendary", name: "Cape d'orichalque", part: "cape", value: "#7a3fc4", rank: "orichalcum" }];
  const items = ForgeItems.create({ save, lootCatalog: CATALOG }, { baseItems, banner: () => undefined, sfx: {}, persist: () => undefined, redraw: () => undefined, rerender: () => undefined, renderHud: () => undefined });
  items.migrate();
  return { save, items };
}

describe("marchand : le stock du jour", () => {
  it("le même jour et la même sauvegarde donnent toujours le même stock ; un autre jour ou un autre sel, un autre", () => {
    const a = Shop.offers("sel1", "2026-11-17", CATALOG);
    expect(a).toEqual(Shop.offers("sel1", "2026-11-17", CATALOG));
    const days = Array.from({ length: 30 }, (_, i) => JSON.stringify(Shop.offers("sel1", `2026-11-${i + 1}`, CATALOG).map((o) => o.itemId)));
    expect(new Set(days).size).toBeGreaterThan(25); // le stock change presque chaque jour
    expect(JSON.stringify(Shop.offers("sel2", "2026-11-17", CATALOG).map((o) => o.itemId))).not.toBe(JSON.stringify(a.map((o) => o.itemId)));
  });

  it("quatre armes uniques (valeurs tirées, graine du stock) et jusqu'à trois tenues différentes, de raretés variées", () => {
    for (let d = 1; d <= 60; d++) {
      const stock = Shop.offers("sel", `2026-12-${d}`, CATALOG);
      const weapons = stock.filter((o) => o.kind === "weapon"), tenues = stock.filter((o) => o.kind === "cosmetic");
      expect(weapons).toHaveLength(4);
      expect(tenues.length).toBeGreaterThan(0);
      expect(tenues.length).toBeLessThanOrEqual(3);
      expect(new Set(tenues.map((t) => t.itemId)).size).toBe(tenues.length);
      for (const w of weapons) {
        const [baseId, seed] = w.itemId.split("#");
        const base = CATALOG.find((c) => c.id === baseId)!;
        expect(base.kind).toBe("weapon");
        expect(base.rarity).toBe(w.rarity);
        expect(seed).toContain("shop-");
        expect(w.quality).toBe(Combat.rollWeapon(base.weapon!, w.rarity, seed!).quality); // l'arme du stock est celle que le sac recalculera
      }
      for (const t of tenues) expect(CATALOG.find((c) => c.id === t.itemId)?.kind).toBe("cosmetic");
    }
  });

  it("les raretés suivent leurs chances (surtout du commun et du rare, du légendaire rarement)", () => {
    const count: Record<string, number> = { common: 0, rare: 0, epic: 0, legendary: 0 };
    let total = 0;
    for (let d = 1; d <= 800; d++) for (const o of Shop.offers("sel", `j${d}`, CATALOG)) { count[o.rarity]!++; total++; }
    Shop.RARITIES.forEach((r, i) => expect(Math.abs((count[r]! / total) * 100 - Shop.WEIGHTS[i]!)).toBeLessThan(5));
    expect(count.legendary).toBeGreaterThan(0);
  });

  it("le prix suit la rareté et, pour une arme, la qualité du jet ; le marchand rachète moins cher qu'il ne vend", () => {
    for (const rarity of Shop.RARITIES) {
      const low = Shop.worth({ kind: "weapon", rarity }, 0), high = Shop.worth({ kind: "weapon", rarity }, 1);
      expect(low).toBe(Math.round(Shop.PRICE[rarity]! * 0.7));
      expect(high).toBe(Math.round(Shop.PRICE[rarity]! * 1.5));
      expect(Shop.worth({ kind: "cosmetic", rarity })).toBeLessThan(Shop.worth({ kind: "weapon", rarity }, 0.5));
      for (const q of [0, 0.3, 0.7, 1]) {
        const buy = Shop.worth({ kind: "weapon", rarity }, q), sell = Shop.sellPrice({ kind: "weapon", rarity }, q);
        expect(sell).toBeLessThan(buy);
        expect(sell).toBeGreaterThanOrEqual(1);
      }
    }
    for (const r of Shop.RARITIES.slice(1)) expect(Shop.PRICE[r]!).toBeGreaterThan(Shop.PRICE[Shop.RARITIES[Shop.RARITIES.indexOf(r) - 1]!]!);
    expect(Shop.SELL_RATE).toBeLessThan(1);
  });

  it("sans catalogue, aucune offre (jamais d'erreur)", () => {
    expect(Shop.offers("sel", "2026-11-17", [])).toEqual([]);
  });

  it("le jour est celui du navigateur, au format année-mois-jour", () => {
    expect(Shop.dayKey(new Date(2026, 10, 7))).toBe("2026-11-7");
  });
});

describe("marchand : acheter et vendre (le sac)", () => {
  it("acheter : l'or baisse, l'arme unique entre dans le sac, et la même offre ne s'achète pas deux fois", () => {
    const { save, items } = bag(5000);
    const offer = items.shopOffers().find((o) => o.kind === "weapon")!;
    expect(offer.bought).toBe(false);
    const r = items.buyOffer(offer.offerId);
    expect(r).toMatchObject({ ok: true, price: offer.price });
    expect(save.gold).toBe(5000 - offer.price);
    expect(items.owns(offer.itemId)).toBe(true);
    expect(offer.itemId).toContain("#shop-");
    expect(save.items[offer.itemId]!.from.bought).toBe(1);
    expect(items.shopOffers().find((o) => o.offerId === offer.offerId)!.bought).toBe(true);
    expect(items.buyOffer(offer.offerId)).toMatchObject({ ok: false });
    expect(save.gold).toBe(5000 - offer.price); // rien de plus n'a été retiré
  });

  it("pas assez d'or : rien ne se passe", () => {
    const { save, items } = bag(1);
    const offer = items.shopOffers()[0]!;
    expect(items.buyOffer(offer.offerId)).toMatchObject({ ok: false, why: "Pas assez d'or." });
    expect(save.gold).toBe(1);
    expect(Object.keys(save.items)).toHaveLength(0);
  });

  it("le lendemain, le stock est renouvelé et les achats de la veille ne comptent plus", () => {
    const { save, items } = bag(9000);
    const today = items.shopOffers();
    items.buyOffer(today[0]!.offerId);
    // Le lendemain : le jour du navigateur change (le stock lit `ForgeShop.dayKey` à chaque fois)
    const real = Shop.dayKey;
    Shop.dayKey = () => "2099-1-1";
    try {
      const tomorrow = items.shopOffers();
      expect(save.shop!.day).toBe("2099-1-1");
      expect(tomorrow.every((o) => !o.bought)).toBe(true);
      expect(JSON.stringify(tomorrow.map((o) => o.itemId))).not.toBe(JSON.stringify(today.map((o) => o.itemId)));
    } finally { Shop.dayKey = real; }
  });

  it("vendre : l'objet QUITTE le sac pour de bon (plus d'entrée, plus possédé, plus « nouveau »)", () => {
    const { save, items } = bag();
    items.add("weapon-sword-rare#forge-1", "loot");
    save.fresh.push("weapon-sword-rare#forge-1");
    expect(items.owns("weapon-sword-rare#forge-1")).toBe(true);
    const sold = items.sellItem("weapon-sword-rare#forge-1");
    expect(sold!.price).toBeGreaterThan(0);
    expect(items.owns("weapon-sword-rare#forge-1")).toBe(false);
    expect(save.items["weapon-sword-rare#forge-1"]).toBeUndefined();
    expect(save.owned).not.toContain("weapon-sword-rare#forge-1");
    expect(save.fresh).not.toContain("weapon-sword-rare#forge-1");
    expect(items.sellable().some((x) => x.item.id === "weapon-sword-rare#forge-1")).toBe(false);
    expect(items.sellItem("weapon-sword-rare#forge-1")).toBeNull(); // on ne vend pas deux fois le même
  });

  it("deux exemplaires : on en vend un, il en reste un", () => {
    const { save, items } = bag();
    items.add("cape-rouge", "bought"); items.add("cape-rouge", "loot");
    expect(items.sellItem("cape-rouge")).not.toBeNull();
    expect(items.count("cape-rouge")).toBe(1);
    expect(save.owned).toContain("cape-rouge");
    expect(items.sellItem("cape-rouge")).not.toBeNull();
    expect(items.owns("cape-rouge")).toBe(false);
  });

  it("un objet porté ne se vend pas ; une fois retiré, si", () => {
    const { items } = bag();
    items.add("weapon-axe-epic#forge-2", "loot");
    items.equip("weapon-axe-epic#forge-2");
    expect(items.sellItem("weapon-axe-epic#forge-2")).toBeNull();
    expect(items.sellable().some((x) => x.item.id === "weapon-axe-epic#forge-2")).toBe(false);
    expect(items.owns("weapon-axe-epic#forge-2")).toBe(true);
    items.unequip("weapon");
    expect(items.sellItem("weapon-axe-epic#forge-2")).not.toBeNull();
    expect(items.owns("weapon-axe-epic#forge-2")).toBe(false);
  });

  it("une tenue de prestige ne se vend pas", () => {
    const { items } = bag();
    items.add("cape-orichalque", "prestige");
    expect(items.sellItem("cape-orichalque")).toBeNull();
    expect(items.sellable().some((x) => x.item.id === "cape-orichalque")).toBe(false);
    expect(items.owns("cape-orichalque")).toBe(true);
  });

  it("acheter puis revendre ne rapporte jamais : on perd de l'or à chaque tour", () => {
    const { save, items } = bag(9000);
    for (const offer of items.shopOffers()) {
      const before = save.gold;
      expect(items.buyOffer(offer.offerId).ok).toBe(true);
      const sold = items.sellItem(offer.itemId)!;
      save.gold += sold.price;
      expect(save.gold).toBeLessThan(before);
    }
  });

  it("un objet qui n'existe pas ne se vend pas", () => {
    const { items } = bag();
    expect(items.sellItem("weapon-sword-rare#inconnu")).toBeNull();
    expect(items.sellItem("n-importe-quoi")).toBeNull();
    expect(items.remove("n-importe-quoi")).toBe(false);
  });
});
