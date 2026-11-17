/* Dessin de la forge : pixel art généré par du code (aucune image). Tuile de 16 px, personnages de 16 x 16 px (coiffes en plus). */
(() => {
  "use strict";
  const T = 16;
  const px = (c, x, y, w, h, col) => { c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };

  const GRADE = {
    common: { name: "Commun", c: "#9aa0ab", d: "#5d626c" },
    rare: { name: "Rare", c: "#4f8bff", d: "#2a4fa8" },
    epic: { name: "Épique", c: "#b062ff", d: "#6a2fb0" },
    legendary: { name: "Légendaire", c: "#ffb02e", d: "#b36b00" },
  };
  const TYPES = [
    { id: "sword", name: "Épée" }, { id: "axe", name: "Hache" }, { id: "hammer", name: "Marteau" }, { id: "dagger", name: "Dague" },
    { id: "spear", name: "Lance" }, { id: "bow", name: "Arc" }, { id: "staff", name: "Bâton" },
  ];
  const WOOD = "#7a4a1c", WOOD2 = "#5a3a1c";
  /** Palette commune des finitions : un seul contour sombre pour tout le jeu, des reflets et des ombres translucides (valables sur n'importe quelle couleur). */
  const OUT = "#1d1a22", GOLD = "#d8b04a", HI = "rgba(255,255,255,.22)", HI2 = "rgba(255,255,255,.4)", SH = "rgba(0,0,0,.2)", SH2 = "rgba(0,0,0,.34)";
  /** Les reflets et ombres translucides (rgba ou hexadécimal à 8 chiffres) ne reçoivent pas de contour. */
  const isSolid = (col) => !/^rgba|^#[0-9a-f]{8}$/i.test(col);
  /**
   * Dessine une liste de rectangles [dx, dy, w, h, couleur, sansContour] à partir de (x, y), agrandis par `s`.
   * Chaque rectangle opaque reçoit d'abord un contour d'une unité, puis tous les remplissages sont posés par-dessus :
   * seul le contour extérieur de la silhouette reste visible, les détails à l'intérieur ne sont pas cernés.
   */
  function sprite(c, x, y, list, s = 1, line = OUT) {
    for (const [dx, dy, w, h, col, bare] of list) if (!bare && isSolid(col)) px(c, x + (dx - 1) * s, y + (dy - 1) * s, (w + 2) * s, (h + 2) * s, line);
    for (const [dx, dy, w, h, col] of list) px(c, x + dx * s, y + dy * s, w * s, h * s, col);
  }

  /** Une arme dans une grille de 12 x 12, cernée d'un contour, agrandie par `s`. Les légendaires brillent. */
  function weapon(c, x, y, type, grade, s = 1) {
    const g = GRADE[grade] || GRADE.common;
    if (grade === "legendary") px(c, x - s, y - s, 14 * s, 14 * s, "rgba(255,200,80,.22)");
    let parts;
    switch (type) {
      case "axe": parts = [[5, 2, 2, 10, WOOD], [6, 2, 1, 10, WOOD2], [5, 11, 2, 1, "#3a2a1c"], [1, 1, 5, 5, g.c], [1, 1, 2, 5, g.d], [0, 2, 1, 3, g.c], [1, 1, 5, 1, "#ffffff66"], [5, 5, 1, 1, g.d]]; break;
      case "hammer": parts = [[5, 3, 2, 9, WOOD], [6, 3, 1, 9, WOOD2], [2, 0, 8, 4, g.c], [2, 0, 8, 1, "#ffffff55"], [2, 3, 8, 1, g.d], [9, 1, 1, 2, g.d], [5, 11, 2, 1, "#3a2a1c"]]; break;
      case "dagger": parts = [[5, 2, 2, 5, g.c], [6, 1, 1, 1, g.c], [5, 2, 1, 5, "#ffffff66"], [6, 3, 1, 4, g.d], [4, 7, 4, 1, GOLD], [5, 8, 2, 2, WOOD], [5, 10, 2, 1, GOLD]]; break;
      case "spear": parts = [[5, 3, 2, 9, WOOD], [6, 3, 1, 9, WOOD2], [4, 1, 4, 2, g.c], [5, 0, 2, 1, g.c], [4, 1, 1, 2, "#ffffff66"], [4, 3, 4, 1, g.d]]; break;
      case "bow": parts = [[8, 0, 1, 2, WOOD], [9, 2, 1, 3, WOOD], [10, 5, 1, 2, WOOD], [9, 7, 1, 3, WOOD], [8, 10, 1, 2, WOOD], [8, 0, 1, 1, "#a06a2c"], [8, 11, 1, 1, "#a06a2c"], [7, 1, 1, 10, "#ddd"], [3, 5, 6, 1, g.c], [2, 4, 2, 3, g.d], [2, 4, 1, 1, "#ffffff66"]]; break;
      case "staff": parts = [[5, 3, 2, 9, WOOD], [6, 3, 1, 9, WOOD2], [4, 0, 4, 4, g.c], [6, 2, 2, 2, g.d], [5, 1, 1, 1, "#fff"], [4, 3, 4, 1, "#5d626c"]]; break;
      default: parts = [[5, 0, 2, 8, g.c], [6, 1, 1, 7, g.d], [5, 0, 1, 7, "#ffffff88"], [3, 8, 6, 1, GOLD], [3, 9, 6, 1, "#8a6a1c"], [5, 9, 2, 2, WOOD], [5, 11, 2, 1, GOLD]]; // épée
    }
    sprite(c, x, y, parts, s);
  }

  const iconCache = new Map();
  /** Adresse d'image (data URL) d'une arme, pour l'afficher dans un popup ; à agrandir en CSS avec `image-rendering: pixelated`. */
  function icon(type, grade) {
    const key = `${type}:${grade}`;
    if (!iconCache.has(key)) {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 14;
      weapon(cv.getContext("2d"), 1, 1, type, grade, 1);
      iconCache.set(key, cv.toDataURL());
    }
    return iconCache.get(key);
  }

  /**
   * Un personnage de 16 x 16 px dont les pieds touchent le bas de la tuile (x, y) : grosse tête ronde, corps court, contour sombre.
   * Les coiffes dépassent d'au plus 6 px au-dessus. Le dessin est écrit pour la face, le dos et la droite ; la gauche en est le miroir.
   * `o` : dir (down, up, left, right), frame (0 repos, 1 et 2 pas), skin, hair, tunic, apron, hat, cape, beard, bald, long (cheveux longs), ears (oreilles pointues), item.
   */
  function person(c, x, y, o = {}) {
    const { dir = "down", frame = 0, skin = "#f2c9a0", hair = "#3a2a1c", tunic = "#3e6fb0", apron = "#6b4423", hat = null, beard = false, item = null, bald = false, cape = null, long = false, ears = false } = o;
    const yb = y + T;
    // Ombre au sol : deux bandes, pour un contour arrondi
    px(c, x + 2, yb - 1, 12, 2, "rgba(0,0,0,.22)"); px(c, x + 4, yb - 2, 8, 1, "rgba(0,0,0,.16)");
    const L = [];
    const flip = dir === "left";
    const side = dir === "left" || dir === "right";
    const r = (dx, dy, w, h, col) => L.push([flip ? T - dx - w : dx, dy, w, h, col]); // coordonnées relatives au coin haut gauche de la tuile (x, y), retournées pour la gauche
    const rr = (dx, dy, w, h, col) => L.push([dx, dy, w, h, col]); // objets tenus : toujours du même côté de l'écran
    const PANTS = "#55506a", BOOT = "#6a4326", BELT = "#3a2a1c", EYE = "#23252b", CHEEK = "rgba(220,90,90,.3)", MOUTH = "rgba(110,40,36,.6)";

    // Vue de face, la cape ne dépasse que derrière les épaules et s'évase derrière les jambes
    if (cape && dir === "down") { r(3, 8, 10, 4, cape); r(2, 12, 12, 3, cape); r(3, 8, 1, 6, HI); r(12, 8, 1, 6, SH); r(2, 14, 12, 1, SH); }

    // Jambes : en marchant, la jambe levée ne montre que sa botte, un rang plus haut
    if (!side) {
      for (const [lx, fx, lift] of [[5, 4, frame === 1], [9, 9, frame === 2]]) {
        if (lift) { r(lx, 13, 2, 1, BOOT); r(fx, 14, 3, 1, BOOT); } else { r(lx, 13, 2, 1, PANTS); r(lx, 14, 2, 1, BOOT); r(fx, 15, 3, 1, BOOT); }
      }
    } else {
      const [a, b] = frame === 0 ? [6, 8] : [5, 9]; // jambe arrière, jambe avant
      for (const [lx, lift, back] of [[a, frame === 2, true], [b, frame === 1, false]]) {
        if (lift) { r(lx, 13, 2, 1, BOOT); r(lx, 14, 3, 1, BOOT); } else { r(lx, 13, 2, 1, PANTS); r(lx, 14, 2, 1, BOOT); r(lx, 15, 3, 1, BOOT); if (back) r(lx, 13, 3, 3, SH); }
      }
    }

    // Torse, jupe de la tunique, tablier, ceinture et bras
    if (!side) {
      r(3, 12, 10, 1, tunic); r(3, 12, 10, 1, SH);
      r(4, 8, 8, 4, tunic); r(4, 8, 8, 1, HI); r(10, 9, 2, 3, SH);
      if (dir === "down") { r(5, 9, 6, 4, apron); r(5, 9, 6, 1, SH); r(10, 10, 1, 3, SH); r(7, 8, 2, 1, skin); }
      r(4, 11, 8, 1, BELT); if (dir === "down") r(7, 11, 2, 1, GOLD);
      const [la, ra] = frame === 1 ? [1, 0] : frame === 2 ? [0, 1] : [0, 0]; // le bras qui avance descend d'un rang
      r(2, 8 + la, 2, 3, tunic); r(2, 8 + la, 2, 1, HI); r(2, 11 + la, 2, 1, skin);
      r(12, 8 + ra, 2, 3, tunic); r(13, 9 + ra, 1, 2, SH); r(12, 11 + ra, 2, 1, skin);
      // De dos la cape couvre tout le dos
      if (cape && dir === "up") { r(3, 8, 10, 7, cape); r(3, 8, 10, 2, HI); r(3, 14, 10, 1, SH); r(7, 10, 2, 4, "rgba(0,0,0,.18)"); r(7, 8, 2, 1, GOLD); }
    } else {
      r(4, 12, 8, 1, tunic); r(4, 12, 8, 1, SH);
      r(5, 8, 6, 4, tunic); r(5, 8, 6, 1, HI); r(5, 9, 1, 3, SH);
      r(8, 9, 3, 4, apron); r(8, 9, 3, 1, SH);
      r(5, 11, 6, 1, BELT); r(10, 11, 1, 1, GOLD);
      // De profil la cape pend dans le dos
      if (cape) { r(3, 8, 5, 7, cape); r(3, 8, 5, 2, HI); r(3, 14, 5, 1, SH); }
      const ax = frame === 1 ? 8 : frame === 2 ? 6 : 7; // le bras balance avec les pas
      r(ax, 8, 2, 3, tunic); r(ax, 8, 2, 1, HI); r(ax, 11, 2, 1, skin);
    }

    // Tête : un octogone arrondi, des cheveux, un visage à deux yeux
    r(5, 0, 6, 1, skin); r(4, 1, 8, 1, skin); r(3, 2, 10, 4, skin); r(4, 6, 8, 1, skin); r(5, 7, 6, 1, skin);
    r(11, 3, 1, 3, "rgba(0,0,0,.1)"); r(5, 7, 6, 1, "rgba(0,0,0,.12)");
    if (ears) { if (!side) { r(2, 3, 1, 2, skin); r(13, 3, 1, 2, skin); } else r(2, 3, 1, 2, skin); }
    if (!bald) {
      if (dir === "up") {
        r(5, 0, 6, 1, hair); r(4, 1, 8, 1, hair); r(3, 2, 10, long ? 7 : 5, hair); r(10, 3, 2, 3, SH);
      } else if (dir === "down") {
        r(5, 0, 6, 1, hair); r(4, 1, 8, 1, hair); r(3, 2, 10, 1, hair); r(3, 3, 3, 1, hair); r(10, 3, 3, 1, hair); r(3, 4, 1, long ? 5 : 2, hair); r(12, 4, 1, long ? 5 : 2, hair);
      } else {
        r(5, 0, 6, 1, hair); r(4, 1, 8, 1, hair); r(3, 2, 10, 1, hair); r(3, 3, 5, long ? 6 : 4, hair); r(8, 3, 4, 1, hair);
      }
      r(5, 0, 3, 1, HI);
    } else r(5, 0, 3, 1, HI2);
    if (dir === "down") {
      r(6, 4, 1, 2, EYE); r(9, 4, 1, 2, EYE); r(5, 6, 1, 1, CHEEK); r(10, 6, 1, 1, CHEEK); if (!beard) r(7, 6, 2, 1, MOUTH);
    } else if (side) {
      r(10, 4, 1, 2, EYE); r(13, 4, 1, 1, skin); r(10, 6, 1, 1, CHEEK); if (!beard) r(11, 6, 1, 1, MOUTH); r(7, 4, 1, 2, "rgba(0,0,0,.14)");
    }
    if (beard && dir !== "up") {
      if (dir === "down") { r(4, 6, 8, 2, hair); r(5, 8, 6, 1, hair); r(7, 6, 2, 1, MOUTH); r(4, 6, 8, 1, HI); } else { r(7, 6, 6, 2, hair); r(8, 8, 4, 1, hair); r(7, 6, 6, 1, HI); }
    }

    // Coiffes : contour, reflet en haut à gauche et ombre à droite
    if (hat === "cap") { r(3, -1, 10, 3, "#9a3b2e"); r(5, -2, 6, 1, "#9a3b2e"); r(3, 1, 10, 1, "#7a2a20"); r(4, -1, 4, 1, HI2); }
    if (hat === "helmet") { r(3, -2, 10, 4, "#9aa0ab"); r(5, -3, 6, 1, "#9aa0ab"); r(7, -5, 2, 2, "#c0392b"); r(3, 2, 10, 1, "#5d626c"); r(4, -2, 3, 2, HI2); r(10, -2, 3, 3, SH); if (dir !== "up") { r(3, 3, 1, 2, "#7a808c"); r(12, 3, 1, 2, "#7a808c"); } if (dir === "down") r(7, 3, 2, 3, "#7a808c"); }
    if (hat === "copper") { r(3, -2, 10, 4, "#c97c3a"); r(5, -3, 6, 1, "#c97c3a"); r(7, -4, 2, 1, "#e8a05a"); r(3, 2, 10, 1, "#8a4a1c"); r(4, -2, 3, 2, HI2); r(10, -2, 3, 3, SH); }
    if (hat === "turban") { r(3, -2, 10, 4, "#2f9a6a"); r(5, -4, 6, 2, "#2f9a6a"); r(7, 0, 2, 1, "#ffd37a"); r(3, 1, 10, 1, "rgba(0,0,0,.2)"); r(4, -2, 4, 1, HI2); r(9, -3, 2, 3, "rgba(0,0,0,.14)"); }
    if (hat === "crown") { r(3, -1, 10, 3, "#f0d078"); r(3, -3, 2, 2, "#f0d078"); r(7, -4, 2, 3, "#f0d078"); r(11, -3, 2, 2, "#f0d078"); r(7, 0, 2, 1, "#c0392b"); r(3, 1, 10, 1, "rgba(120,80,0,.3)"); r(4, -1, 3, 1, HI2); }
    if (hat === "bandana") { r(3, 0, 10, 2, "#c0392b"); r(12, 1, 2, 3, "#c0392b"); r(4, 0, 3, 1, "#e8685a"); }
    if (hat === "feather") { r(3, -2, 10, 3, "#2f7a5a"); r(2, 1, 12, 1, "#1f5a40"); r(11, -6, 2, 5, "#f0d078"); r(12, -7, 1, 2, "#fff7d0"); r(4, -2, 4, 1, HI2); }
    if (hat === "viking") { r(3, -2, 10, 3, "#9aa0ab"); r(3, 1, 10, 1, "#5d626c"); r(1, -4, 2, 4, "#e8e4da"); r(13, -4, 2, 4, "#e8e4da"); r(0, -5, 1, 2, "#e8e4da"); r(15, -5, 1, 2, "#e8e4da"); r(4, -2, 3, 2, HI2); r(10, -2, 3, 2, SH); }
    if (hat === "knight") { r(3, -3, 10, 8, "#b9bfca"); r(3, 4, 10, 1, "#6a707c"); if (dir !== "up") r(5, 1, 6, 2, "#23252b"); r(7, -6, 2, 3, "#c0392b"); r(4, -3, 3, 3, HI2); r(10, -3, 3, 4, SH); }
    if (hat === "wizard") { r(2, 0, 12, 2, "#3a2f7a"); r(4, -2, 8, 2, "#4a3f9a"); r(5, -4, 6, 2, "#4a3f9a"); r(6, -5, 4, 1, "#4a3f9a"); r(8, -6, 2, 1, "#4a3f9a"); r(4, -1, 8, 1, "#f0d078"); r(4, -2, 3, 1, HI2); }
    if (hat === "scribe") { r(3, -2, 10, 3, "#2d2a4a"); r(4, -3, 8, 1, "#2d2a4a"); r(3, 1, 10, 1, "#1d1a30"); r(4, -2, 3, 1, HI); }

    // Objet tenu
    if (item === "hammer") { const up = frame ? 3 : 0; rr(13, 4 - up, 1, 8, WOOD); rr(11, 2 - up, 5, 3, "#9aa0ab"); rr(11, 2 - up, 5, 1, HI2); rr(11, 4 - up, 5, 1, SH2); }
    if (item === "book") { rr(11, 8, 5, 4, "#7a2a20"); rr(12, 9, 3, 2, "#f5e9c8"); rr(11, 8, 1, 4, "rgba(0,0,0,.25)"); }
    if (item === "shield") { rr(0, 7, 4, 6, "#3a5fa0"); rr(1, 8, 2, 4, "#ffd37a"); rr(0, 7, 4, 1, HI2); rr(3, 8, 1, 5, SH); }
    sprite(c, x, y, L);
    // Arme équipée (butin ou échange) : « weapon:<type>:<rareté> », tenue à la main droite (dessinée par-dessus le personnage)
    if (typeof item === "string" && item.startsWith("weapon:")) { const [, wt, wg] = item.split(":"); weapon(c, x + 9, y + 2, wt, wg, 1); }
  }

  const LOOKS = {
    brann: { hair: "#e8e4da", tunic: "#8a3b12", apron: "#4a3a2a", skin: "#e0b088", beard: true, bald: true },
    apprenti: { hair: "#3a2a1c", tunic: "#3e9a6a", apron: "#6b4423", hat: "cap" },
    apprenti2: { hair: "#23252b", tunic: "#b0503e", apron: "#6b4423", hat: "cap" },
    apprenti3: { hair: "#8a3b12", tunic: "#8a5cb0", apron: "#6b4423", hat: "cap" },
    gardien: { hair: "#3a2a1c", tunic: "#3a5fa0", apron: "#9aa0ab", hat: "helmet", item: "shield" },
    scribe: { hair: "#8a5a3a", tunic: "#4a3a7a", apron: "#d8cfa8", hat: "scribe", item: "book", skin: "#d9a066" },
    marchand: { hair: "#222", tunic: "#2f7a5a", apron: "#d8b04a", hat: "turban", skin: "#d9a066" },
    king: { hair: "#8a6a3a", tunic: "#7a1f2e", apron: "#f0d078", hat: "crown", skin: "#e0b088", beard: true },
    queen: { hair: "#3a2a1c", tunic: "#4a2f8a", apron: "#e8e4da", hat: "crown", skin: "#f2c9a0", long: true },
    noble: { hair: "#222", tunic: "#2f6a8a", apron: "#c9c4b0", skin: "#d9a066" },
    armurier: { hair: "#3a2a1c", tunic: "#7a2f2f", apron: "#4a4a52", skin: "#d9a066", hat: "helmet", beard: true, item: "weapon:axe:epic" },
    architecte: { hair: "#7a5a3a", tunic: "#2a7f86", apron: "#d8cfa8", skin: "#e0b088", hat: "copper", beard: true },
  };

  /** Tapis : bordure dorée et liseré intérieur (les franges sont ajoutées par `carpet`, quand le tapis ne touche pas un mur). */
  function carpetRug(c, tx, ty, w, h, a, b, e) {
    const X = tx * T, Y = ty * T, Wd = w * T, Hd = h * T;
    px(c, X, Y, Wd, Hd, a); px(c, X + 3, Y + 3, Wd - 6, Hd - 6, b);
    px(c, X + 5, Y + 5, Wd - 10, 1, "rgba(240,208,120,.45)"); px(c, X + 5, Y + Hd - 6, Wd - 10, 1, "rgba(240,208,120,.45)");
    px(c, X + 5, Y + 5, 1, Hd - 10, "rgba(240,208,120,.45)"); px(c, X + Wd - 6, Y + 5, 1, Hd - 10, "rgba(240,208,120,.45)");
    px(c, X + 3, Y + 3, Wd - 6, 1, "rgba(255,255,255,.12)"); px(c, X + 3, Y + Hd - 4, Wd - 6, 1, SH);
    px(c, X, Y, Wd, 2, e); px(c, X, Y + Hd - 2, Wd, 2, e);
    px(c, X, Y + 2, Wd, 1, "rgba(0,0,0,.25)");
  }
  function torch(c, tx, ty, t) {
    const x = tx * T, y = ty * T, f = Math.floor(t * 6) % 3;
    sprite(c, x, y, [[6, 6, 4, 8, WOOD2], [6, 6, 1, 8, WOOD], [4, 4, 8, 3, "#555b66"], [4, 4, 8, 1, "#8a909c"]]);
    px(c, x + 5, y - 1 - (f === 1 ? 1 : 0), 6, 6, "#ff7a1a"); px(c, x + 6, y + 1 - (f === 2 ? 1 : 0), 4, 4, "#ffc83d"); px(c, x + 7, y + 2 - (f === 2 ? 1 : 0), 2, 2, "#fff3b0");
    glow(x + 8, y + 5, 34, "255,150,60", 0.32);
  }
  /** Four de 4 x 3 tuiles ; allumé (flammes qui dansent) ou éteint (cendres). */
  function furnace(c, tx, ty, lit, t = 0) {
    const x = tx * T, y = ty * T;
    const L = [
      [39, -14, 16, 3, "#6a6674"], [40, -11, 14, 15, "#4a4752"], [40, -11, 2, 15, HI], [50, -11, 4, 15, SH], [39, -14, 16, 1, HI2],
      [41, -6, 12, 1, "#383540", true], [47, -11, 1, 5, "#383540", true], [44, -5, 1, 5, "#383540", true],
      [0, 0, 64, 48, "#5d5a66"],
    ];
    // Briques décalées d'une rangée à l'autre
    for (let j = 0; j < 4; j++) {
      if (j) L.push([0, j * 12, 64, 1, "#434650", true]);
      for (const bx of j % 2 ? [8, 40] : [24, 56]) L.push([bx, j * 12 + 1, 1, 11, "#434650", true]);
    }
    L.push([0, 0, 64, 2, HI], [0, 2, 64, 1, "rgba(255,255,255,.06)"], [60, 3, 4, 45, SH], [0, 44, 64, 4, "rgba(0,0,0,.18)"]);
    L.push([12, 14, 40, 3, "#3a3744"], [12, 14, 40, 1, "#6a6674"], [30, 14, 4, 3, "#8a8698"], [14, 16, 36, 26, "#18120e"], [14, 16, 36, 2, "rgba(0,0,0,.5)"], [14, 40, 36, 2, "#2a2622"]);
    sprite(c, x, y, L);
    if (lit) {
      const f = Math.floor(t * 7) % 3;
      px(c, x + 18, y + 26 - f, 8, 14 + f, "#ff7a1a"); px(c, x + 28, y + 22 + f, 8, 18 - f, "#ff9a2a"); px(c, x + 38, y + 28, 8, 12, "#ff7a1a");
      px(c, x + 22, y + 32, 6, 8, "#ffc83d"); px(c, x + 32, y + 30, 6, 10, "#ffd96a");
      px(c, x + 24, y + 36, 3, 4, "#fff3b0"); px(c, x + 34, y + 35, 3, 5, "#fff3b0");
      px(c, x + 14, y + 40, 36, 2, "#6a2a10"); px(c, x + 12, y + 41, 40, 1, "rgba(255,150,60,.35)");
      glow(x + 32, y + 36, 64, "255,140,50", 0.38);
    } else {
      px(c, x + 18, y + 38, 28, 4, "#2a2622"); px(c, x + 24, y + 36, 6, 2, "#3a3430"); px(c, x + 36, y + 37, 4, 1, "#4a4540");
    }
  }
  function anvil(c, tx, ty) {
    const x = tx * T, y = ty * T;
    px(c, x + 3, y + 15, 14, 2, "rgba(0,0,0,.22)");
    sprite(c, x, y, [[2, 6, 14, 3, "#a3a9b5"], [15, 7, 3, 2, "#7d838f"], [2, 9, 12, 2, "#7d838f"], [5, 11, 6, 2, "#7d838f"], [3, 13, 10, 3, "#6a707c"],
      [2, 6, 14, 1, "#d6dae2"], [3, 9, 10, 1, "#9aa0ab"], [3, 15, 10, 1, SH2], [12, 11, 3, 2, SH]]);
  }
  function board(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [4, 28, 3, 6, WOOD2], [25, 28, 3, 6, WOOD2], [4, 28, 1, 6, WOOD],
      [0, 0, 32, 28, "#4a2f18"], [0, 0, 32, 1, "#6a4a2c"], [2, 2, 28, 24, "#8a6a3a"], [2, 2, 28, 1, SH], [2, 2, 1, 24, SH], [29, 3, 1, 23, HI],
      [5, 5, 9, 11, "#f5e9c8"], [17, 6, 9, 9, "#f0e0b0"], [8, 16, 12, 8, "#f5e9c8"],
      [5, 15, 9, 1, SH], [17, 14, 9, 1, SH], [8, 23, 12, 1, SH],
      [9, 3, 2, 3, "#c0392b"], [21, 4, 2, 3, "#2f6fb0"], [12, 17, 2, 3, "#3a8a4a"],
      [6, 8, 6, 1, "#7a6a4a", true], [6, 11, 6, 1, "#7a6a4a", true], [6, 13, 4, 1, "#7a6a4a", true], [19, 9, 6, 1, "#7a6a4a", true], [19, 11, 4, 1, "#7a6a4a", true],
      [10, 19, 8, 1, "#7a6a4a", true], [10, 21, 5, 1, "#7a6a4a", true],
    ]);
  }
  /** Pierre d'éveil : ses runes brillent en bleu quand Claude est connecté. */
  function stone(c, tx, ty, on, t = 0) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [2, 6, 12, 22, "#7a7d88"], [4, 2, 8, 6, "#8a8d98"], [2, 24, 12, 4, "#5d606a"],
      [4, 2, 3, 6, HI], [2, 6, 2, 18, HI], [11, 6, 3, 18, SH], [11, 2, 1, 6, SH], [3, 27, 10, 1, SH2], [5, 25, 2, 1, "#6a8a5a"], [8, 24, 3, 1, "#6a8a5a"],
    ]);
    const col = on ? "#7dd4ff" : "#4a5060", p = on ? 1 + (Math.floor(t * 3) % 2) : 1;
    px(c, x + 7, y + 8, 2, 4 * p, col); px(c, x + 5, y + 14, 6, 1, col); px(c, x + 6, y + 17, 1, 3, col); px(c, x + 9, y + 17, 1, 3, col);
    if (on) glow(x + 8, y + 14, 30, "125,212,255", 0.28);
  }
  /** Râtelier de 6 x 2 tuiles garni d'armes [type, qualité]. */
  function rack(c, tx, ty, list) {
    const x = tx * T, y = ty * T, w = 6 * T;
    px(c, x + 6, y + 40, w - 12, 2, "rgba(0,0,0,.25)");
    sprite(c, x, y, [
      [0, 0, w, 36, "#5a3d24"], [3, 3, w - 6, 30, "#6e4a2c"], [3, 3, w - 6, 1, SH], [3, 3, 1, 30, SH],
      [0, 14, w, 3, "#3e2a18"], [0, 14, w, 1, "#6a4a2c"], [0, 33, w, 3, "#3e2a18"], [0, 33, w, 1, "#6a4a2c"], [0, 0, 4, 40, "#3e2a18"], [w - 4, 0, 4, 40, "#3e2a18"],
      [0, 0, 1, 40, "#6a4a2c"], [w - 4, 0, 1, 40, "#6a4a2c"], [1, 38, 2, 2, "#2a1c10"], [w - 3, 38, 2, 2, "#2a1c10"],
    ]);
    list.slice(0, 6).forEach((it, i) => weapon(c, x + 8 + i * 14, y + 3 + (i % 2) * 17, it[0], it[1], 1));
  }
  function stall(c, tx, ty) {
    const x = tx * T, y = ty * T, w = 6 * T;
    const L = [[2, 14, 3, 30, WOOD2], [w - 5, 14, 3, 30, WOOD2], [2, 14, 1, 30, WOOD]];
    // Auvent rayé, festonné à son bord
    for (let i = 0; i < 12; i++) L.push([i * 8, 0, 8, 12, i % 2 ? "#f5f0e1" : "#2f9a6a"], [i * 8 + 1, 12, 6, 2, i % 2 ? "#f5f0e1" : "#2f9a6a"], [i * 8 + 3, 14, 2, 1, i % 2 ? "#f5f0e1" : "#2f9a6a"]);
    L.push([0, 0, w, 1, HI2], [0, 9, w, 3, SH], [0, 12, w, 1, SH]);
    L.push([0, 32, w, 14, "#7a4a1c"], [0, 32, w, 3, "#a06a2c"], [0, 35, w, 1, "#c08a4c"], [0, 46, w, 2, "#4a2a10"], [0, 38, w, 1, "rgba(0,0,0,.2)", true], [0, 42, w, 1, "rgba(0,0,0,.2)", true]);
    // Marchandises : pièces d'or, fioles rouge et bleue
    L.push([8, 26, 5, 6, "#ffd37a"], [8, 26, 2, 6, "#fff0b0"], [15, 28, 5, 4, "#ffd37a"], [15, 28, 5, 1, "#fff0b0"], [60, 25, 6, 7, "#c0392b"], [61, 26, 1, 3, "#ffffff88"], [62, 23, 2, 2, "#d8cfa8"],
      [70, 27, 6, 5, "#4f8bff"], [71, 28, 1, 2, "#ffffff88"], [72, 25, 2, 2, "#d8cfa8"]);
    sprite(c, x, y, L);
  }
  function barrel(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [[2, 2, 12, 14, "#7a4a1c"], [3, 0, 10, 3, "#8a5a2c"], [3, 0, 10, 1, "#a8743c"], [3, 2, 2, 14, HI], [11, 2, 3, 14, SH],
      [2, 5, 12, 1, "#3e2a18"], [2, 11, 12, 1, "#3e2a18"], [2, 6, 12, 1, "#8a909c"], [2, 12, 12, 1, "#8a909c"], [7, 3, 1, 13, "rgba(0,0,0,.15)", true]]);
  }
  function crate(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [[1, 3, 14, 13, "#8a5a2c"], [1, 3, 14, 1, "#a8743c"], [1, 4, 14, 1, HI], [7, 3, 2, 13, "#5a3a1c"], [1, 9, 14, 1, "#5a3a1c"], [1, 15, 14, 1, SH2],
      [3, 5, 1, 1, "#c8c8d0"], [12, 5, 1, 1, "#c8c8d0"], [3, 12, 1, 1, "#c8c8d0"], [12, 12, 1, 1, "#c8c8d0"]]);
  }
  /** Étincelles du marteau sur l'enclume. */
  function sparks(c, x, y, t) {
    for (let i = 0; i < 4; i++) { const a = (t * 3 + i * 0.9) % 1; px(c, x + i * 3 - 4 + a * (i % 2 ? 10 : -8), y - a * 14, 2, 2, a < 0.7 ? "#ffd37a" : "#ff7a1a"); }
  }
  /** Gerbe d'étoiles quand quelqu'un ou quelque chose apparaît dans la forge (k de 0 à 1). */
  function sparkle(c, x, y, k) {
    const n = 8, r = 4 + k * 22;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + k * 2;
      px(c, x + Math.cos(a) * r - 1, y + Math.sin(a) * r - 1, 3, 3, i % 2 ? "#ffd37a" : "#fff6c8");
    }
    c.fillStyle = `rgba(255,230,150,${0.35 * (1 - k)})`; c.beginPath(); c.arc(x, y, 6 + k * 18, 0, Math.PI * 2); c.fill();
  }
  /** Flèche qui rebondit au-dessus de ce qu'on peut toucher. */
  function pointer(c, x, y, t) {
    const b = Math.round(Math.sin(t * 6) * 1.5);
    px(c, x - 2, y + b, 5, 1, "#ffd37a"); px(c, x - 1, y + b + 1, 3, 1, "#ffd37a"); px(c, x, y + b + 2, 1, 1, "#ffd37a");
  }


  /* ---------- rendu net : détails au demi-pixel, ombres et lumières douces ---------- */
  // Le monde est dessiné sur un canevas en double résolution (voir `game.js`) : une unité de dessin = 2 pixels écran. Les personnages et les
  // objets gardent leurs gros pixels ; le sol, les murs et la lumière sont finis au demi-pixel, avec des dégradés, donc plus nets et moins en escalier.
  const fx = (c, x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  const half = (v) => Math.round(v * 2) / 2;
  /** Hasard déterministe : le même décor à chaque dessin (variations de dalles, fissures, mousse). */
  function hash(a, b = 0) {
    let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  /** Les sources de lumière de l'image en cours, vidées à chaque `lightPass`. */
  const lights = [];
  /** Déclare une lumière (flamme, portail...) : `rgb` comme « 255,150,60 », `a` son intensité. Elle s'affiche dans `lightPass`, par-dessus tout le décor. */
  function glow(x, y, r, rgb, a = 0.25) { if (lights.length < 64) lights.push({ x, y, r, rgb, a }); }
  /** Lumières douces (dégradés additifs qui vacillent) puis vignette : à appeler une fois par image, après le dessin de la salle et de ses habitants. */
  function lightPass(c, t, w, h) {
    c.save();
    c.globalCompositeOperation = "lighter";
    for (const l of lights) {
      const k = 0.88 + 0.12 * Math.sin(t * 9 + l.x * 0.7 + l.y * 0.3) + 0.04 * Math.sin(t * 23 + l.x);
      const g = c.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
      g.addColorStop(0, `rgba(${l.rgb},${(l.a * k).toFixed(3)})`); g.addColorStop(0.5, `rgba(${l.rgb},${(l.a * k * 0.4).toFixed(3)})`); g.addColorStop(1, `rgba(${l.rgb},0)`);
      c.fillStyle = g; c.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }
    c.restore();
    lights.length = 0;
    const W2 = w * T, H2 = h * T, v = c.createRadialGradient(W2 / 2, H2 / 2, H2 * 0.32, W2 / 2, H2 / 2, W2 * 0.62);
    v.addColorStop(0, "rgba(8,5,14,0)"); v.addColorStop(1, "rgba(8,5,14,.34)");
    c.fillStyle = v; c.fillRect(0, 0, W2, H2);
  }
  /** Ombre douce posée au sol (une ellipse qui s'estompe) : sous les piliers, les statues, les meubles. */
  function softShadow(c, cx, cy, rx, ry, a = 0.34) {
    c.save(); c.translate(cx, cy); c.scale(1, ry / rx);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(0.6, `rgba(0,0,0,${a * 0.5})`); g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, rx, 0, Math.PI * 2); c.fill(); c.restore();
  }
  /** Toile d'araignée dans un coin : rayons et fils (sx, sy : sens de la toile à partir du coin). */
  function web(c, x, y, sx, sy, size = 15) {
    c.save(); c.strokeStyle = "rgba(235,235,245,.16)"; c.lineWidth = 0.5;
    const pts = (r) => [0, 1, 2, 3, 4].map((i) => { const a = (i / 4) * (Math.PI / 2); return [x + sx * Math.cos(a) * r, y + sy * Math.sin(a) * r]; });
    for (const [px2, py2] of pts(size)) { c.beginPath(); c.moveTo(x, y); c.lineTo(px2, py2); c.stroke(); }
    for (const r of [size * 0.35, size * 0.65, size]) { const p = pts(r); c.beginPath(); c.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) { const mx = (p[i][0] + p[i - 1][0]) / 2 - sx * 0.8, my = (p[i][1] + p[i - 1][1]) / 2 - sy * 0.8; c.quadraticCurveTo(mx, my, p[i][0], p[i][1]); } c.stroke(); }
    c.restore();
  }
  /** Sol et murs finis au demi-pixel : variation des dalles, joints doubles, fissures, gravillons, briques teintées, mousse, ombres de fond. */
  function polishShell(c, w, h, p) {
    const wood = p === THEMES.tavern, marble = p === THEMES.castle, W2 = w * T;
    for (let y = 3; y < h - 1; y++) for (let x = 0; x < w; x++) {
      const X = x * T, Y = y * T, r = hash(x * 31 + 7, y * 17 + 3), r2 = hash(x * 11 + 5, y * 29 + 1);
      fx(c, X, Y, T, T, r < 0.5 ? `rgba(255,255,255,${(0.01 + r * 0.04).toFixed(3)})` : `rgba(0,0,0,${(0.01 + (r - 0.5) * 0.06).toFixed(3)})`);
      if (wood) {
        // Planches : deux joints par tuile, décalés, et des veinures
        for (const [yy, off] of [[5, 0], [10.5, 6]]) {
          fx(c, X, Y + yy, T, 0.5, "rgba(0,0,0,.26)"); fx(c, X, Y + yy + 0.5, T, 0.5, "rgba(255,230,180,.07)");
          fx(c, X + ((off + x * 5) % 12) + 1, Y + yy - 5, 0.5, 5, "rgba(0,0,0,.22)");
        }
        for (let k = 0; k < 5; k++) fx(c, X + half(hash(x * 3 + k, y * 5) * 12) + 1, Y + half(hash(x * 7, y * 3 + k) * 14) + 1, half(2 + hash(k, x + y) * 4), 0.5, "rgba(0,0,0,.12)");
        continue;
      }
      // Joints doubles : un trait sombre et un reflet d'un demi-pixel, coins écaillés
      fx(c, X, Y + T - 0.5, T, 0.5, "rgba(0,0,0,.2)"); fx(c, X + T - 0.5, Y, 0.5, T, "rgba(0,0,0,.16)");
      fx(c, X, Y + 0.5, T, 0.5, "rgba(255,255,255,.06)"); fx(c, X + 0.5, Y, 0.5, T, "rgba(255,255,255,.05)");
      fx(c, X, Y, 1, 1, "rgba(255,255,255,.07)"); fx(c, X + T - 1, Y + T - 1, 1, 1, "rgba(0,0,0,.14)");
      if (marble && r2 > 0.8) for (let k = 0; k < 6; k++) fx(c, X + 2 + k * 1.5 + hash(k, x + y) * 1.5, Y + 12 - k * 1.5, 1, 0.5, "rgba(255,255,255,.045)");
      // Fissure : une marche de petits segments
      if (r > 0.94 || r2 > 0.975) {
        let cx = X + 2 + hash(x, y) * 11, cy = Y + 2 + hash(y, x) * 11;
        for (let k = 0; k < 8; k++) {
          const horiz = hash(x * 9 + k, y * 4) > 0.5, len = 1 + Math.floor(hash(x + k, y * 3) * 2);
          fx(c, half(cx), half(cy), horiz ? len : 0.5, horiz ? 0.5 : len, "rgba(0,0,0,.22)");
          fx(c, half(cx) + 0.5, half(cy) + 0.5, horiz ? len : 0.5, horiz ? 0.5 : len, "rgba(255,255,255,.05)");
          if (horiz) cx += hash(k, x) > 0.4 ? len : -len; else cy += len;
        }
      }
      for (let k = 0; k < 3; k++) fx(c, half(X + 1 + hash(x * 13 + k, y * 7 + 1) * 13), half(Y + 1 + hash(x * 5 + 2, y * 11 + k) * 13), 0.5, 0.5, k ? "rgba(0,0,0,.22)" : "rgba(255,255,255,.09)");
    }
    // Murs du haut : briques teintées une à une, joints au demi-pixel, mousse et traînées
    for (let y = 0; y < 3; y++) for (let x = 0; x < w; x++) {
      const X = x * T, Y = y * T;
      for (let i = 0; i < 2; i++) {
        const r = hash(x * 5 + i, y * 13 + 2);
        fx(c, X + i * 8, Y, 8, T - 1, r < 0.5 ? `rgba(255,255,255,${(0.01 + r * 0.05).toFixed(3)})` : `rgba(0,0,0,${(0.015 + (r - 0.5) * 0.07).toFixed(3)})`);
      }
      fx(c, X, Y + T - 1.5, T, 0.5, "rgba(0,0,0,.25)"); fx(c, X, Y + 0.5, T, 0.5, "rgba(255,255,255,.07)");
      const jx = X + (y % 2 ? 8 : 0); fx(c, jx + 0.5, Y, 0.5, T - 1, "rgba(255,255,255,.05)");
      if (y === 2 && hash(x, 99) > 0.74) { fx(c, X + 3, Y + 11, 8, 4, "rgba(70,110,60,.17)"); for (let k = 0; k < 5; k++) fx(c, half(X + 3 + hash(x + k, 5) * 8), half(Y + 10 + hash(k, x) * 4), 0.5, 1, "rgba(120,170,90,.22)"); }
      if (hash(x * 3, y + 40) > 0.8) { const g = c.createLinearGradient(0, Y, 0, Y + T); g.addColorStop(0, "rgba(0,0,0,.18)"); g.addColorStop(1, "rgba(0,0,0,0)"); c.fillStyle = g; c.fillRect(X + 4 + hash(x, 3) * 6, Y, 1.5, T); }
    }
    // Profondeur : le haut du mur dans l'ombre, et une ombre douce du mur sur le sol
    let g = c.createLinearGradient(0, 0, 0, 3 * T); g.addColorStop(0, "rgba(0,0,0,.42)"); g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g; c.fillRect(0, 0, W2, 3 * T);
    g = c.createLinearGradient(0, 3 * T, 0, 3 * T + 12); g.addColorStop(0, "rgba(0,0,0,.34)"); g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g; c.fillRect(0, 3 * T, W2, 12);
    // Mur du bas : mêmes briques, et l'ombre douce qu'il jette vers le haut
    for (let x = 0; x < w; x++) {
      const X = x * T, Y = (h - 1) * T, r = hash(x * 5, 77);
      fx(c, X, Y, T, T, r < 0.5 ? "rgba(255,255,255,.02)" : "rgba(0,0,0,.05)"); fx(c, X, Y + 0.5, T, 0.5, "rgba(255,255,255,.07)");
    }
    g = c.createLinearGradient(0, (h - 1) * T - 8, 0, (h - 1) * T); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.28)");
    c.fillStyle = g; c.fillRect(0, (h - 1) * T - 8, W2, 8);
    // Toiles d'araignée dans les coins du haut
    web(c, 0, 0, 1, 1); web(c, W2, 0, -1, 1, 13);
    // Une très légère lumière chaude au centre de la salle
    const L = c.createRadialGradient(W2 / 2, h * T * 0.6, 8, W2 / 2, h * T * 0.6, W2 * 0.55);
    L.addColorStop(0, "rgba(255,225,170,.06)"); L.addColorStop(1, "rgba(255,225,170,0)");
    c.fillStyle = L; c.fillRect(0, 3 * T, W2, (h - 4) * T);
  }
  /** Tapis du hall : tissage au demi-pixel et losanges. */
  function polishCarpet(c, tx, ty, w, h) {
    const X = tx * T, Y = ty * T, Wd = w * T, Hd = h * T;
    for (let yy = Y + 6; yy < Y + Hd - 6; yy += 2) fx(c, X + 6, yy, Wd - 12, 0.5, "rgba(255,255,255,.035)");
    for (let xx = X + 6; xx < X + Wd - 6; xx += 2) fx(c, xx, Y + 6, 0.5, Hd - 12, "rgba(0,0,0,.05)");
    for (let k = 0; k < Math.floor((Hd - 20) / 16); k++) {
      const cx = X + Wd / 2, cy = Y + 14 + k * 16;
      for (let i = 0; i < 5; i++) fx(c, cx - 4 + i, cy - i, 8 - 2 * i, 0.5, "rgba(240,208,120,.4)"), fx(c, cx - 4 + i, cy + i, 8 - 2 * i, 0.5, "rgba(240,208,120,.4)");
      fx(c, cx - 1, cy - 0.5, 2, 1, "rgba(240,208,120,.65)");
    }
    fx(c, X, Y + Hd - 2.5, Wd, 0.5, "rgba(0,0,0,.2)");
  }
  /** Le calque fixe d'une salle (sol, murs, et pour le hall : tapis et porte), rendu une fois en double résolution. */
  function buildRoomLayer(w, h, theme, hall) {
    const cv = document.createElement("canvas");
    cv.width = w * T * 2; cv.height = h * T * 2;
    const c = cv.getContext("2d");
    c.imageSmoothingEnabled = false; c.scale(2, 2);
    const name = hall ? "forge" : theme;
    roomShell(c, 0, w, h, name);
    polishShell(c, w, h, THEMES[name] || THEMES.forge);
    if (hall) {
      const cx = Math.floor(w / 2) - 4;
      carpetRug(c, cx, 4, 8, h - 5, "#5a2f3a", "#6e3a47", "#c9a35b");
      polishCarpet(c, cx, 4, 8, h - 5);
      hallZones(c);
      doorBottom(c, Math.floor(w / 2) - 1, h);
    }
    return cv;
  }
  /** Les torches du hall (animées, donc dessinées à chaque image par-dessus le calque fixe). */
  function roomTorches(c, t, w) {
    const cx = Math.floor(w / 2) - 4;
    [0, w - 1, cx - 2, cx + 9].forEach((tx, i) => torch(c, tx, 2, t + i));
  }

  /* ---------- salles décrites par des données : thèmes, décors, porte du fond ---------- */
  const THEMES = {
    forge: { f1: "#4b4452", f2: "#453e4c", spot: "#3b3542", w1: "#2b2732", w2: "#1d1a22", trim: null },
    castle: { f1: "#6b708a", f2: "#626780", spot: "#565a72", w1: "#3a3f58", w2: "#2a2e44", trim: "#c9a35b" },
    tavern: { f1: "#7a5530", f2: "#704e2c", spot: "#5e3f22", w1: "#4a3320", w2: "#33220f", trim: "#a06a2c" },
  };
  /** Sol et murs d'une salle (sans tapis ni porte : ils viennent des objets de la salle). */
  function roomShell(c, t, w, h, theme) {
    const p = THEMES[theme] || THEMES.forge;
    for (let y = 3; y < h - 1; y++) for (let x = 0; x < w; x++) {
      const X = x * T, Y = y * T;
      px(c, X, Y, T, T, (x + y) % 2 ? p.f1 : p.f2);
      // Dalle : arête claire en haut et à gauche, jointure sombre en bas et à droite
      px(c, X, Y, T, 1, "rgba(255,255,255,.06)"); px(c, X, Y, 1, T, "rgba(255,255,255,.04)");
      px(c, X, Y + T - 1, T, 1, "rgba(0,0,0,.12)"); px(c, X + T - 1, Y, 1, T, "rgba(0,0,0,.09)");
      if ((x * 7 + y * 13) % 11 === 0) { px(c, X + 4, Y + 5, 3, 2, p.spot); px(c, X + 4, Y + 5, 3, 1, "rgba(255,255,255,.05)"); }
      if ((x * 5 + y * 3) % 13 === 0) px(c, X + 10, Y + 9, 2, 1, p.spot);
    }
    for (let y = 0; y < 3; y++) for (let x = 0; x < w; x++) {
      const X = x * T, Y = y * T;
      px(c, X, Y, T, T, p.w1); px(c, X, Y + T - 1, T, 1, p.w2); px(c, X + (y % 2 ? 8 : 0), Y, 1, T - 1, p.w2);
      // Pierres : arête claire en haut, léger creux sous la jointure
      px(c, X, Y, T, 1, "rgba(255,255,255,.07)"); px(c, X, Y + T - 2, T, 1, "rgba(0,0,0,.1)");
    }
    // Ombre portée du mur sur le sol, à plat (aucune perspective)
    px(c, 0, 3 * T, w * T, 2, "rgba(0,0,0,.26)"); px(c, 0, 3 * T + 2, w * T, 2, "rgba(0,0,0,.12)");
    if (p.trim) { px(c, 0, 3 * T - 3, w * T, 2, p.trim); px(c, 0, 3 * T - 3, w * T, 1, "rgba(255,255,255,.25)"); px(c, 0, 3 * T - 1, w * T, 1, p.w2); }
    for (let x = 0; x < w; x++) { px(c, x * T, (h - 1) * T, T, T, p.w1); px(c, x * T, (h - 1) * T, T, 1, "rgba(255,255,255,.07)"); px(c, x * T + (x % 2 ? 8 : 0), (h - 1) * T + 1, 1, T - 1, p.w2); }
  }
  /** Porte de deux tuiles dans le mur du bas : encadrement de pierre, planches, ferrures. */
  function doorBottom(c, tx, h = 15, style = "wood", t = 0) {
    if (style === "iron") return ironGate(c, tx, h, t);
    const y = (h - 1) * T;
    sprite(c, tx * T, y, [
      [-4, -4, 2 * T + 8, T + 4, "#3a2a1c"], [-4, -4, 2 * T + 8, 1, HI], [-4, -4, 3, T + 4, HI], [2 * T + 1, -4, 3, T + 4, SH],
      [0, 0, 2 * T, T, "#7a4a1c"], [T - 1, 0, 2, T, "#4a2a10"],
      [7, 0, 1, T, "rgba(0,0,0,.2)"], [23, 0, 1, T, "rgba(0,0,0,.2)"], [0, 0, 2 * T, 2, "rgba(0,0,0,.25)"], [1, 2, 4, T - 2, HI],
      [1, 3, 5, 2, "#2a2a30"], [26, 3, 5, 2, "#2a2a30"], [1, 11, 5, 2, "#2a2a30"], [26, 11, 5, 2, "#2a2a30"],
      [4, 8, 3, 3, "#ffd37a"], [4, 8, 3, 1, "#fff0b0"],
      [0, -2, 2 * T, 2, "#ffe9a0"],
    ]);
  }
  /** Herse de fer de l'arène (deux tuiles dans le mur du bas) : arche de pierre sombre, barreaux, lueur rouge, écu aux épées croisées, torches. Un autre dessin que les portes de bois et les portes magiques. */
  function ironGate(c, tx, h = 15, t = 0) {
    const x = tx * T, y = (h - 1) * T;
    sprite(c, x, y, [[-5, -6, 2 * T + 10, T + 6, "#3d3a48"], [-5, -6, 2 * T + 10, 2, HI2], [-5, -6, 3, T + 6, HI], [2 * T + 2, -6, 3, T + 6, SH], [-1, -3, 2 * T + 2, T + 3, "#1a0d10"]]);
    c.globalAlpha = 0.3 + 0.12 * Math.sin(t * 3); px(c, x - 1, y - 3, 2 * T + 2, T + 3, "#c0392b"); c.globalAlpha = 1;
    glow(x + T, y + 6, 36, "220,60,50", 0.18);
    for (let i = 0; i < 8; i++) { px(c, x + i * 4, y - 3, 2, T + 3, "#7d838f"); px(c, x + i * 4, y - 3, 1, T + 3, "#c8ced8"); px(c, x + i * 4, y + T - 3, 2, 3, "#e8ecf2"); }
    px(c, x - 1, y + 2, 2 * T + 2, 2, "#4a4f5a"); px(c, x - 1, y + 10, 2 * T + 2, 2, "#4a4f5a");
    // Écu rouge au centre, deux épées croisées
    px(c, x + 11, y - 2, 10, 13, "#7a2a2a"); px(c, x + 11, y - 2, 10, 1, "#c8aa4a"); px(c, x + 11, y + 10, 10, 1, "#c8aa4a");
    for (let i = 0; i < 7; i++) { px(c, x + 12 + i, y - 1 + i, 2, 2, "#e8ecf2"); px(c, x + 18 - i, y - 1 + i, 2, 2, "#e8ecf2"); }
    px(c, x + 14, y + 3, 4, 3, "#f0d078");
    // Torches de part et d'autre de l'arche
    for (const tx2 of [x - 9, x + 2 * T + 5]) {
      const f = Math.floor(t * 8 + tx2) % 2;
      px(c, tx2 + 1, y + 2, 3, 8, "#3b2616"); px(c, tx2, y - 3 + f, 5, 5, "#ff9a2a"); px(c, tx2 + 1, y - 2 + f, 3, 3, "#ffd37a");
      glow(tx2 + 2, y - 1, 26, "255,150,50", 0.3);
    }
  }
  /** Porte magique dans le mur du fond de la forge, qui mène à une salle (2 x 2 tuiles à partir de (tx, ty)). */
  function hubDoor(c, tx, ty, t = 0) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [[0, 0, 32, 32, "#6e6a7a"], [2, 2, 28, 30, "#4a4756"], [0, 0, 32, 1, HI2], [0, 0, 2, 32, HI], [30, 0, 2, 32, SH], [5, 6, 22, 26, "#1b1430"], [5, 6, 22, 2, "rgba(0,0,0,.4)"],
      [3, 0, 26, 4, "#8a8698"], [3, 0, 26, 1, HI2], [11, -2, 10, 3, "#a9a6b4"], [14, 0, 4, 2, "#8a6aff"]]);
    for (let i = 0; i < 4; i++) { const f = Math.floor(t * 3 + i) % 3; px(c, x + 8 + i * 5, y + 9 + f * 6, 2, 3, "#8a6aff"); px(c, x + 10 + i * 4, y + 12 + ((f + 1) % 3) * 5, 1, 2, "#c4b0ff"); }
    glow(x + 16, y + 20, 40, "138,106,255", 0.3);
  }

  const CLOTH = {
    red: ["#7a2a3a", "#9a3a4c", "#f0d078"], blue: ["#2a3f7a", "#3a56a0", "#f0d078"], green: ["#2a6a4a", "#3a8a60", "#f0d078"],
    purple: ["#5a2a7a", "#7a3aa0", "#f0d078"], gold: ["#b8903a", "#d8b04a", "#fff0b0"],
  };
  const OBJECT_NAME = { throne: "Trône", statue: "Statue", table: "Table", chest: "Coffre", window: "Fenêtre", bookshelf: "Bibliothèque", dummy: "Mannequin", armorstand: "Armure", brazier: "Brasero", plant: "Plante", fountain: "Fontaine", tapestry: "Tapisserie" };

  /** Tapis : posé au sol, sous les meubles. */
  function carpet(c, tx, ty, w, h, color) {
    const [a, b, e] = CLOTH[color] || CLOTH.red, X = tx * T, Y = ty * T, Hd = h * T;
    carpetRug(c, tx, ty, w, h, a, b, e);
    for (let i = 0; i < w * 2; i++) px(c, X + 2 + i * 8, Y + Hd, 3, 2, e);
  }
  function pillar(c, tx, ty) {
    const x = tx * T, y = ty * T;
    softShadow(c, x + 8, y + 31, 13, 4.5, 0.4);
    sprite(c, x, y, [
      [2, 27, 12, 5, "#8a8794"], [2, 27, 12, 1, "#b9b6c4"], [3, 5, 10, 22, "#a9a6b4"], [10, 5, 3, 22, "#8a8794"], [4, 5, 2, 22, "#c8c5d2"],
      [7, 6, 1, 20, "rgba(0,0,0,.1)", true], [1, 1, 14, 5, "#b9b6c4"], [1, 1, 14, 1, HI2], [1, 5, 14, 1, "#8a8794"], [2, 29, 12, 3, SH],
    ]);
  }
  function statue(c, tx, ty) {
    const x = tx * T, y = ty * T;
    softShadow(c, x + 8, y + 31, 13, 4.5, 0.4);
    sprite(c, x, y, [
      [2, 22, 12, 10, "#7d7a88"], [2, 22, 12, 2, "#9a97a6"], [2, 22, 12, 1, HI2], [11, 24, 3, 8, SH], [5, 9, 6, 13, "#a9a6b4"], [9, 9, 2, 13, "#8a8794"],
      [6, 3, 5, 6, "#b9b6c4"], [9, 3, 2, 6, "#a9a6b4"], [6, 3, 5, 1, HI2], [3, 10, 3, 8, "#a9a6b4"], [11, 10, 3, 8, "#8a8794"], [5, 9, 6, 1, HI],
      [7, 5, 1, 1, "#6a6776"], [9, 5, 1, 1, "#6a6776"], [7, 15, 2, 1, "#8a8794"],
    ]);
  }
  function throne(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [4, 0, 24, 22, "#c9a35b"], [4, 0, 24, 1, HI2], [4, 0, 2, 22, HI], [26, 1, 2, 21, SH], [8, 4, 16, 16, "#7a2a3a"], [10, 6, 12, 12, "#9a3a4c"], [10, 6, 12, 1, SH], [10, 6, 1, 12, SH],
      [4, -3, 4, 4, "#f0d078"], [14, -5, 4, 6, "#f0d078"], [24, -3, 4, 4, "#f0d078"], [4, -3, 4, 1, "#fff0b0"], [14, -5, 4, 1, "#fff0b0"], [24, -3, 4, 1, "#fff0b0"],
      [15, 2, 2, 2, "#c0392b"], [2, 16, 5, 14, "#c9a35b"], [25, 16, 5, 14, "#c9a35b"], [2, 16, 5, 1, HI2], [25, 16, 5, 1, HI2], [5, 17, 1, 13, SH], [29, 17, 1, 13, SH],
      [6, 20, 20, 8, "#7a2a3a"], [6, 20, 20, 2, "#b04a5c"], [6, 27, 20, 1, SH], [2, 28, 28, 4, "#8a8794"], [2, 28, 28, 1, "#b9b6c4"], [2, 31, 28, 1, SH2],
    ]);
  }
  function table(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [3, 22, 4, 10, "#5a3a1c"], [41, 22, 4, 10, "#5a3a1c"], [3, 22, 1, 10, WOOD], [41, 22, 1, 10, WOOD],
      [0, 6, 48, 13, "#8a5a2c"], [0, 6, 48, 2, "#a06a2c"], [0, 8, 48, 1, HI], [0, 19, 48, 4, "#5a3a1c"], [0, 19, 48, 1, SH],
      [10, 12, 1, 1, "rgba(0,0,0,.15)", true], [30, 14, 6, 1, "rgba(0,0,0,.12)", true],
      [8, 9, 5, 4, "#d8c48a"], [8, 9, 5, 1, "#f5e9c8"], [24, 8, 3, 5, "#9aa0ab"], [24, 8, 1, 5, "#d6dae2"], [34, 8, 3, 5, "#9aa0ab"], [34, 8, 1, 5, "#d6dae2"],
    ]);
  }
  function chair(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [[3, 12, 2, 4, "#5a3a1c"], [11, 12, 2, 4, "#5a3a1c"], [3, 1, 10, 8, "#6a4220"], [3, 1, 10, 1, "#8a5a2c"], [4, 3, 8, 1, "rgba(0,0,0,.18)"], [3, 8, 10, 4, "#8a5a2c"], [3, 8, 10, 1, "#a8743c"], [3, 11, 10, 1, SH]]);
  }
  function chest(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [1, 6, 14, 10, "#8a5a2c"], [1, 3, 14, 4, "#a06a2c"], [2, 2, 12, 1, "#a06a2c"], [1, 3, 14, 1, HI2], [1, 6, 14, 1, "#5a3a1c"], [1, 15, 14, 1, SH2],
      [3, 3, 2, 13, "#c9a35b"], [11, 3, 2, 13, "#c9a35b"], [3, 3, 1, 13, "#fff0b0"], [11, 3, 1, 13, "#fff0b0"], [7, 7, 2, 3, "#ffd37a"], [7, 7, 2, 1, "#fff0b0"],
    ]);
  }
  function banner(c, tx, ty, color) {
    const [a, b, e] = CLOTH[color] || CLOTH.red, x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [1, 1, 14, 2, "#c9a35b"], [1, 1, 14, 1, "#f0d078"], [3, 3, 10, 19, a], [4, 22, 8, 2, a], [6, 24, 4, 3, a], [3, 3, 3, 19, b], [11, 4, 2, 18, SH], [3, 3, 10, 1, SH],
      [7, 8, 2, 9, e], [5, 11, 6, 2, e], [7, 8, 2, 1, "#ffffff88"], [1, 1, 2, 3, "#c9a35b"], [13, 1, 2, 3, "#c9a35b"],
    ]);
  }
  function windowSprite(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [2, 1, 28, 31, "#c9a35b"], [2, 1, 28, 1, "#f0d078"], [2, 1, 2, 31, HI], [28, 2, 2, 30, SH], [4, 3, 24, 28, "#16204a"], [4, 3, 24, 8, "#1e2a5e"], [4, 3, 24, 1, "rgba(0,0,0,.35)"],
      [8, 7, 2, 2, "#fff"], [20, 12, 2, 2, "#fff"], [13, 20, 1, 1, "#cfd6e0"], [24, 6, 1, 1, "#cfd6e0"],
      [17, 7, 6, 6, "#f5e9c8"], [19, 7, 4, 6, "#16204a"],
      [15, 3, 2, 28, "#5a4a2a"], [4, 16, 24, 2, "#5a4a2a"], [15, 3, 1, 28, "#7a6a3a"], [4, 16, 24, 1, "#7a6a3a"], [1, 30, 30, 2, "#a9895a"], [1, 30, 30, 1, "#d8b87a"],
    ]);
  }
  function bookshelf(c, tx, ty) {
    const x = tx * T, y = ty * T, cols = ["#8a3b3b", "#3b6a8a", "#4a8a4a", "#c9a35b", "#6a3b8a", "#b07a3a"];
    const L = [[0, 0, 32, 32, "#5a3a1c"], [0, 0, 32, 1, "#7a4a1c"], [2, 2, 28, 28, "#3e2a18"], [2, 2, 28, 1, SH2]];
    for (let s = 0; s < 3; s++) {
      const sy = 3 + s * 9;
      for (let i = 0; i < 9; i++) {
        const hgt = 5 + ((i * 5 + s * 3 + tx) % 3), col = cols[(i + s * 2 + tx) % cols.length];
        L.push([3 + i * 3, sy + (8 - hgt), 2, hgt, col], [3 + i * 3, sy + (8 - hgt), 1, hgt, HI]);
      }
      L.push([2, sy + 8, 28, 1, "#7a4a1c"], [2, sy + 9, 28, 1, SH]);
    }
    sprite(c, x, y, L);
  }
  /** Dessine un objet de salle (voir src/rooms/catalog.ts). Un type inconnu devient une caisse : jamais d'erreur. */
  /* ---------- décors supplémentaires : mannequin, armure, brasero, plante, fontaine, tapisserie ---------- */
  /** Mannequin d'entraînement : poteau, traverse, corps de paille cerclé, cible sur la poitrine. */
  function dummy(c, tx, ty) {
    const x = tx * T, y = ty * T;
    softShadow(c, x + 8, y + 31, 9, 3.5, 0.34);
    sprite(c, x, y, [
      [3, 29, 10, 3, "#5a3a1c"], [3, 29, 10, 1, WOOD], [7, 12, 2, 18, WOOD2], [7, 12, 1, 18, "#9a6a34"],
      [2, 13, 12, 2, WOOD2], [2, 13, 12, 1, WOOD],
      [4, 9, 8, 12, "#c9a85a"], [4, 9, 8, 1, "#e8d28a"], [10, 10, 2, 10, SH], [4, 13, 8, 1, "#8a6a2c"], [4, 18, 8, 1, "#8a6a2c"],
      [5, 2, 6, 7, "#b8975a"], [5, 2, 6, 1, "#d8b878"], [10, 3, 1, 5, SH], [6, 5, 1, 1, "#2a1d12"], [9, 5, 1, 1, "#2a1d12"], [7, 7, 2, 1, "#2a1d12"],
      [6, 11, 4, 4, "#e8e4da"], [7, 12, 2, 2, "#c0392b"], [11, 14, 4, 1, "#c8aa4a"], [14, 13, 1, 3, "#c0392b"],
    ]);
  }
  /** Armure sur son support : heaume à plumet, plastron, tabard, jupe, socle. */
  function armorstand(c, tx, ty) {
    const x = tx * T, y = ty * T;
    softShadow(c, x + 8, y + 31, 9, 3.5, 0.34);
    sprite(c, x, y, [
      [4, 28, 8, 3, "#5a3a1c"], [4, 28, 8, 1, WOOD], [7, 20, 2, 8, WOOD2],
      [4, 17, 8, 4, "#7d838f"], [4, 17, 8, 1, "#b9bfca"], [2, 10, 2, 7, "#8a909c"], [12, 10, 2, 7, "#8a909c"], [2, 10, 2, 1, HI2],
      [4, 9, 8, 9, "#9aa0ab"], [4, 9, 8, 1, HI2], [10, 10, 2, 8, SH], [4, 16, 8, 1, "#8a6a1c"], [7, 11, 2, 5, "#9a2a2a"], [7, 11, 2, 1, "#f0d078"],
      [5, 2, 6, 7, "#b9bfca"], [5, 2, 6, 1, HI2], [10, 3, 1, 6, SH], [6, 5, 4, 1, "#23252b"], [7, 0, 2, 3, "#c0392b"],
    ]);
  }
  /** Brasero de fer : trépied, coupe, braises et flammes qui dansent (et éclairent). */
  function brazier(c, tx, ty, t = 0) {
    const x = tx * T, y = ty * T, f = Math.floor(t * 8 + tx) % 3;
    softShadow(c, x + 8, y + 15, 8, 3, 0.34);
    sprite(c, x, y, [[4, 10, 2, 5, "#3a3a44"], [10, 10, 2, 5, "#3a3a44"], [7, 11, 2, 4, "#2e2e36"], [3, 7, 10, 4, "#4a4a55"], [3, 7, 10, 1, "#8a909c"], [4, 10, 8, 1, SH2], [4, 6, 8, 2, "#7a2a10"]]);
    px(c, x + 5, y + 1 - (f === 1 ? 1 : 0), 6, 6, "#ff7a1a"); px(c, x + 6, y - (f === 2 ? 1 : 0) + 1, 4, 5, "#ffc83d"); px(c, x + 7, y + 3, 2, 3, "#fff3b0");
    glow(x + 8, y + 4, 44, "255,140,50", 0.34);
  }
  /** Plante en pot. */
  function plant(c, tx, ty) {
    const x = tx * T, y = ty * T;
    softShadow(c, x + 8, y + 15, 7, 2.5, 0.3);
    sprite(c, x, y, [
      [4, 10, 8, 5, "#a8582a"], [4, 10, 8, 1, "#c9753a"], [10, 11, 2, 4, SH], [5, 14, 6, 1, "#7a3a1a"], [5, 9, 6, 2, "#3a2a1c"],
      [6, 2, 4, 8, "#2f7a3a"], [3, 4, 4, 5, "#3a8a46"], [9, 3, 4, 6, "#3a8a46"], [2, 6, 3, 3, "#2a6a34"], [11, 6, 3, 3, "#2a6a34"],
      [6, 2, 1, 6, "#6ac46a"], [4, 4, 1, 3, "#6ac46a"], [10, 4, 1, 3, "#6ac46a"], [7, 0, 2, 2, "#e8685a"], [7, 0, 1, 1, "#ffd0c8"],
    ]);
  }
  /** Fontaine de pierre de 2 x 2 tuiles : vasque, eau qui ondule, jet central. */
  function fountain(c, tx, ty, t = 0) {
    const x = tx * T, y = ty * T, k = Math.floor(t * 3) % 3;
    softShadow(c, x + 16, y + 30, 18, 5.5, 0.38);
    sprite(c, x, y, [
      [1, 18, 30, 11, "#a9a6b4"], [1, 18, 30, 1, HI2], [1, 27, 30, 3, "#6a6776"], [3, 16, 26, 3, "#b9b6c4"], [3, 16, 26, 1, "#d4d1de"],
      [4, 18, 24, 7, "#3a8ad0"], [4, 18, 24, 2, "#6ab8ff"], [4, 24, 24, 1, "#2a6aa8"],
      [13, 7, 6, 12, "#b9b6c4"], [13, 7, 2, 12, HI2], [17, 8, 2, 11, SH], [10, 5, 12, 3, "#a9a6b4"], [10, 5, 12, 1, HI2],
    ]);
    px(c, x + 6 + k * 6, y + 20, 5, 1, "rgba(255,255,255,.45)"); px(c, x + 16 - k * 3, y + 22, 6, 1, "rgba(255,255,255,.3)");
    px(c, x + 15, y + 0 + (k === 1 ? 1 : 0), 2, 5, "#9ad7ff"); px(c, x + 12, y + 3 + k, 1, 2, "#bfe4ff"); px(c, x + 19, y + 4 - (k === 2 ? 1 : 0), 1, 2, "#bfe4ff");
    glow(x + 16, y + 14, 26, "125,212,255", 0.14);
  }
  /** Tapisserie du mur du fond (2 x 2) : tringle, étoffe bordée, écu brodé, franges. */
  function tapestry(c, tx, ty, color) {
    const [a, b, e] = CLOTH[color] || CLOTH.red, x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [1, 0, 30, 3, "#5a3a1c"], [1, 0, 30, 1, WOOD], [-1, -1, 3, 5, "#c8aa4a"], [30, -1, 3, 5, "#c8aa4a"],
      [3, 3, 26, 25, a], [5, 5, 22, 21, b], [5, 5, 22, 1, HI], [23, 6, 4, 20, SH],
      [11, 8, 10, 13, e], [12, 9, 8, 11, a], [13, 11, 6, 2, e], [15, 10, 2, 8, e], [14, 14, 4, 1, e],
      [3, 28, 26, 2, e], [5, 30, 1, 2, e], [11, 30, 1, 2, e], [16, 30, 1, 2, e], [21, 30, 1, 2, e], [26, 30, 1, 2, e],
    ]);
  }

  /** Établi d'échange (2 x 1 tuiles, les objets dépassent vers le haut) : comptoir, balance qui oscille, pièces et gemmes des quatre raretés. */
  function tradebench(c, tx, ty, t = 0) {
    const x = tx * T, y = ty * T, k = Math.sin(t * 1.6) * 1.2;
    softShadow(c, x + 16, y + 15, 17, 4, 0.34);
    sprite(c, x, y, [
      [1, 5, 30, 10, "#7a4a1c"], [1, 5, 30, 1, "#a06a2c"], [1, 6, 30, 1, HI], [1, 13, 30, 2, "#5a3a1c"], [24, 7, 6, 6, SH], [5, 7, 1, 6, "rgba(0,0,0,.2)", true], [13, 7, 1, 6, "rgba(0,0,0,.2)", true],
      [2, 15, 3, 1, "#3a2410"], [27, 15, 3, 1, "#3a2410"],
      [15, -7, 2, 12, "#c8aa4a"], [15, -7, 1, 12, "#f0d078"], [14, 4, 4, 1, "#a8872a"], [11, -8, 10, 2, "#c8aa4a"], [12, -8, 3, 1, "#f0d078"],
    ]);
    // Les plateaux de la balance oscillent doucement
    const l = Math.round(k), r = -Math.round(k);
    px(c, x + 10, y - 6 + l, 1, 5, "#8a909c"); px(c, x + 21, y - 6 + r, 1, 5, "#8a909c");
    sprite(c, x, y, [[6, -1 + l, 9, 2, "#c8aa4a"], [6, -1 + l, 9, 1, "#f0d078"], [17, -1 + r, 9, 2, "#c8aa4a"], [17, -1 + r, 9, 1, "#f0d078"]]);
    // Pièces et gemmes : commun, rare, épique, légendaire
    sprite(c, x, y, [[2, 1, 4, 4, "#f0d078"], [2, 1, 4, 1, "#fff0b0"], [3, 3, 4, 3, "#d8b04a"], [8, 3, 3, 3, "#9aa0ab"], [20, 3, 3, 3, "#4f8bff"], [24, 2, 3, 4, "#b062ff"], [28, 3, 3, 3, "#ffb02e"], [28, 3, 3, 1, "#ffe9a0"]]);
    glow(x + 26, y + 2, 20, "176,98,255", 0.12);
  }

  /* ---------- coins du hall : tapis de zone (armurerie, marché, scriptorium, arène) ---------- */
  /** Tapis de zone au demi-pixel : ombre, bordure, fond tissé, coutures, puis un emblème tracé (`kind`). Les cases sont celles de `buildEntities` (`game.js`). */
  function zoneMat(c, tx, ty, w, h, base, edge, accent, kind, ex, ey) {
    const X = tx * T + 2, Y = ty * T + 2, Wd = w * T - 4, Hd = h * T - 4;
    fx(c, X - 0.5, Y - 0.5, Wd + 1, Hd + 2, "rgba(0,0,0,.4)");
    fx(c, X, Y, Wd, Hd, edge); fx(c, X + 1.5, Y + 1.5, Wd - 3, Hd - 3, base);
    if (kind === "market") for (let i = 0; i < Wd - 3; i += 8) fx(c, X + 1.5 + i, Y + 1.5, 4, Hd - 3, "rgba(255,240,210,.16)");
    for (let yy = Y + 4; yy < Y + Hd - 4; yy += 2) fx(c, X + 4, yy, Wd - 8, 0.5, "rgba(255,255,255,.045)");
    for (let i = 4; i < Wd - 4; i += 3) { fx(c, X + i, Y + 3, 1, 0.5, accent); fx(c, X + i, Y + Hd - 3.5, 1, 0.5, accent); }
    for (let j = 4; j < Hd - 4; j += 3) { fx(c, X + 3, Y + j, 0.5, 1, accent); fx(c, X + Wd - 3.5, Y + j, 0.5, 1, accent); }
    fx(c, X, Y, Wd, 0.5, "rgba(255,255,255,.18)"); fx(c, X, Y + Hd - 0.5, Wd, 0.5, "rgba(0,0,0,.3)");
    c.save(); c.strokeStyle = accent; c.fillStyle = accent; c.globalAlpha = 0.6; c.lineCap = "round";
    const cx = ex, cy = ey;
    if (kind === "armory") { // épées croisées et écu
      c.lineWidth = 1.6; c.beginPath(); c.moveTo(cx - 9, cy - 8); c.lineTo(cx + 9, cy + 8); c.moveTo(cx + 9, cy - 8); c.lineTo(cx - 9, cy + 8); c.stroke();
      c.lineWidth = 1; c.beginPath(); c.moveTo(cx - 12, cy - 4); c.lineTo(cx - 6, cy - 10); c.moveTo(cx + 12, cy - 4); c.lineTo(cx + 6, cy - 10); c.stroke();
    } else if (kind === "market") { // pièce
      c.lineWidth = 1.4; c.beginPath(); c.arc(cx, cy, 8, 0, Math.PI * 2); c.stroke(); c.lineWidth = 0.8; c.beginPath(); c.arc(cx, cy, 5.2, 0, Math.PI * 2); c.stroke();
      c.fillRect(cx - 0.8, cy - 3, 1.6, 6);
    } else if (kind === "scribe") { // plume et parchemin
      c.lineWidth = 1.4; c.beginPath(); c.moveTo(cx - 7, cy + 8); c.quadraticCurveTo(cx + 2, cy - 2, cx + 9, cy - 9); c.stroke();
      c.lineWidth = 0.8; c.beginPath(); c.moveTo(cx - 3, cy + 5); c.quadraticCurveTo(cx + 5, cy, cx + 8, cy - 6); c.stroke();
      c.lineWidth = 1; c.strokeRect(cx - 12, cy + 3, 10, 7);
    } else { // arène : anneau et rayons
      c.lineWidth = 1.4; c.beginPath(); c.ellipse(cx, cy, 14, 9, 0, 0, Math.PI * 2); c.stroke(); c.lineWidth = 0.7; c.beginPath(); c.ellipse(cx, cy, 10, 6, 0, 0, Math.PI * 2); c.stroke();
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.beginPath(); c.moveTo(cx + Math.cos(a) * 10, cy + Math.sin(a) * 6); c.lineTo(cx + Math.cos(a) * 14, cy + Math.sin(a) * 9); c.stroke(); }
    }
    c.restore();
  }
  /** Les quatre tapis de zone du hall. */
  function hallZones(c) {
    zoneMat(c, 1, 5, 6, 5, "#4a3220", "#2a1c12", "#c9a35b", "armory", 4 * T, 7.45 * T);
    zoneMat(c, 16, 6, 7, 5, "#7a3226", "#3a1810", "#f0d078", "market", 19.5 * T, 10.45 * T);
    zoneMat(c, 1, 10, 7, 4, "#2a3f7a", "#141c3a", "#f0d078", "scribe", 6 * T, 12.2 * T);
    zoneMat(c, 16, 11, 7, 3, "#b9945a", "#7a5a2a", "#5a3a18", "arena", 19.5 * T, 12.2 * T);
  }

  function drawObject(c, o, t = 0) {
    const w = o.w || 1, h = o.h || 1;
    switch (o.type) {
      case "carpet": return carpet(c, o.x, o.y, w, h, o.color);
      case "pillar": return pillar(c, o.x, o.y);
      case "statue": return statue(c, o.x, o.y);
      case "throne": return throne(c, o.x, o.y);
      case "table": return table(c, o.x, o.y);
      case "chair": return chair(c, o.x, o.y);
      case "chest": return chest(c, o.x, o.y);
      case "barrel": return barrel(c, o.x, o.y);
      case "crate": return crate(c, o.x, o.y);
      case "torch": return torch(c, o.x, o.y, t + o.x * 0.3);
      case "banner": return banner(c, o.x, o.y, o.color);
      case "window": return windowSprite(c, o.x, o.y);
      case "bookshelf": return bookshelf(c, o.x, o.y);
      case "dummy": return dummy(c, o.x, o.y);
      case "armorstand": return armorstand(c, o.x, o.y);
      case "brazier": return brazier(c, o.x, o.y, t + o.x * 0.4);
      case "plant": return plant(c, o.x, o.y);
      case "fountain": return fountain(c, o.x, o.y, t);
      case "tapestry": return tapestry(c, o.x, o.y, o.color);
      default: return crate(c, o.x, o.y);
    }
  }

  window.ForgeSprites = { tradebench, dummy, armorstand, brazier, plant, fountain, tapestry, glow, lightPass, softShadow, buildRoomLayer, roomTorches, polishShell, fx, hash, half, T, px, GRADE, TYPES, weapon, icon, person, LOOKS, roomShell, doorBottom, ironGate, hubDoor, drawObject, OBJECT_NAME, torch, furnace, anvil, board, stone, rack, stall, barrel, crate, sparks, sparkle, pointer };
})();
