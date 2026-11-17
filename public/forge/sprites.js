/* Dessin de la forge : pixel art généré par du code (aucune image). Tuile de 16 px, personnages de 16 x 20 px. */
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

  /** Un personnage dont les pieds touchent le bas de la tuile (x, y). `look` : peau, cheveux, tunique, tablier, chapeau, cape, barbe, objet tenu. */
  function person(c, x, y, o = {}) {
    const { dir = "down", frame = 0, skin = "#f2c9a0", hair = "#3a2a1c", tunic = "#3e6fb0", apron = "#6b4423", hat = null, beard = false, item = null, bald = false, cape = null } = o;
    const yb = y + T;
    // Ombre au sol : deux bandes, pour un contour arrondi
    px(c, x + 2, yb - 1, 12, 2, "rgba(0,0,0,.22)"); px(c, x + 4, yb - 2, 8, 1, "rgba(0,0,0,.16)");
    const L = [];
    const r = (dx, dy, w, h, col) => L.push([dx, dy, w, h, col]); // coordonnées relatives au coin haut gauche de la tuile (x, y)
    // Vue de face, la cape ne dépasse que derrière les épaules (dessinée avant le corps)
    if (cape && dir === "down") { r(3, 4, 10, 9, cape); r(3, 4, 2, 9, HI); r(11, 4, 2, 9, SH); }
    // Jambes et bottes
    r(5, 12 + (frame === 1 ? 1 : 0), 2, frame === 1 ? 3 : 4, "#3b3a47"); r(9, 12 + (frame === 2 ? 1 : 0), 2, frame === 2 ? 3 : 4, "#3b3a47");
    r(5, 15, 2, 1, "#23252b"); r(9, 15, 2, 1, "#23252b");
    // Torse, tablier, ceinture, bras et mains
    r(4, 5, 8, 8, tunic); r(4, 5, 8, 1, HI); r(10, 6, 2, 7, SH);
    if (dir !== "up") { r(5, 7, 6, 6, apron); r(5, 7, 6, 1, SH); r(10, 8, 1, 5, SH); }
    r(4, 11, 8, 1, "#3a2a1c");
    r(2, 5, 2, 6, tunic); r(12, 5, 2, 6, tunic); r(2, 5, 2, 1, HI); r(13, 6, 1, 5, SH);
    r(2, 11, 2, 2, skin); r(12, 11, 2, 2, skin); r(2, 12, 2, 1, SH); r(12, 12, 2, 1, SH);
    // De dos la cape couvre tout le dos ; de profil elle pend du côté qui suit (dessinée par-dessus le corps)
    if (cape && dir !== "down") {
      const [cx, cw] = dir === "up" ? [3, 10] : dir === "left" ? [9, 5] : [2, 5];
      r(cx, 4, cw, 10, cape);
      r(cx, 4, cw, 2, "rgba(255,255,255,.18)");
      r(cx, 13, cw, 1, "rgba(0,0,0,.28)");
      if (dir === "up") r(7, 6, 2, 7, "rgba(0,0,0,.18)");
    }
    // Tête, cheveux, visage
    r(4, -2, 8, 7, skin); r(4, 4, 8, 1, SH); r(10, -1, 2, 5, "rgba(0,0,0,.1)");
    if (!bald) {
      r(4, -2, 8, dir === "up" ? 7 : 3, hair);
      if (dir !== "up") { r(3, -1, 1, 4, hair); r(12, -1, 1, 4, hair); }
      r(5, -2, 3, 1, HI);
    }
    if (dir === "down") { r(6, 2, 1, 2, "#23252b"); r(9, 2, 1, 2, "#23252b"); r(5, 4, 1, 1, "rgba(220,90,90,.28)"); r(10, 4, 1, 1, "rgba(220,90,90,.28)"); }
    if (dir === "left") { r(5, 2, 1, 2, "#23252b"); r(5, 4, 1, 1, "rgba(220,90,90,.28)"); }
    if (dir === "right") { r(10, 2, 1, 2, "#23252b"); r(10, 4, 1, 1, "rgba(220,90,90,.28)"); }
    if (beard) { r(4, 3, 8, 4, "#e8e4da"); r(6, 4, 4, 1, skin); r(4, 6, 8, 1, "rgba(0,0,0,.14)"); }
    // Coiffes : contour et reflet sur le dessus
    if (hat === "cap") { r(3, -4, 10, 3, "#9a3b2e"); r(3, -2, 10, 1, "#7a2a20"); r(4, -4, 4, 1, HI2); }
    if (hat === "helmet") { r(3, -4, 10, 4, "#9aa0ab"); r(7, -7, 2, 3, "#c0392b"); r(3, -1, 10, 1, "#5d626c"); r(4, -4, 3, 3, HI2); r(10, -4, 3, 3, SH); }
    if (hat === "copper") { r(3, -4, 10, 4, "#c97c3a"); r(3, -1, 10, 1, "#8a4a1c"); r(7, -5, 2, 2, "#e8a05a"); r(4, -4, 3, 3, HI2); r(10, -4, 3, 3, SH); }
    if (hat === "turban") { r(3, -5, 10, 5, "#2f9a6a"); r(6, -7, 4, 2, "#2f9a6a"); r(7, -4, 2, 1, "#ffd37a"); r(3, -2, 10, 1, "rgba(0,0,0,.2)"); r(4, -5, 4, 1, HI2); }
    if (hat === "crown") { r(3, -5, 10, 3, "#f0d078"); r(3, -7, 2, 2, "#f0d078"); r(7, -8, 2, 3, "#f0d078"); r(11, -7, 2, 2, "#f0d078"); r(7, -4, 2, 1, "#c0392b"); r(3, -3, 10, 1, "rgba(120,80,0,.3)"); r(4, -5, 4, 1, HI2); }
    if (hat === "bandana") { r(4, -3, 8, 2, "#c0392b"); r(11, -2, 2, 3, "#c0392b"); r(5, -3, 2, 1, "#e8685a"); }
    if (hat === "feather") { r(3, -4, 10, 3, "#2f7a5a"); r(3, -2, 10, 1, "#1f5a40"); r(11, -9, 2, 6, "#f0d078"); r(12, -10, 1, 2, "#fff7d0"); r(4, -4, 4, 1, HI2); }
    if (hat === "viking") { r(3, -4, 10, 4, "#9aa0ab"); r(3, -1, 10, 1, "#5d626c"); r(1, -8, 2, 5, "#e8e4da"); r(13, -8, 2, 5, "#e8e4da"); r(2, -4, 2, 2, "#e8e4da"); r(12, -4, 2, 2, "#e8e4da"); r(4, -4, 3, 3, HI2); r(10, -4, 3, 3, SH); }
    if (hat === "knight") { r(3, -5, 10, 6, "#b9bfca"); r(3, 0, 10, 1, "#6a707c"); r(5, -2, 6, 2, "#23252b"); r(7, -9, 2, 4, "#c0392b"); r(4, -5, 3, 3, HI2); r(10, -5, 3, 3, SH); }
    if (hat === "wizard") { r(2, -4, 12, 2, "#3a2f7a"); r(4, -7, 8, 3, "#4a3f9a"); r(6, -10, 4, 3, "#4a3f9a"); r(7, -12, 2, 2, "#4a3f9a"); r(4, -5, 8, 1, "#f0d078"); r(4, -7, 3, 1, HI2); }
    if (hat === "scribe") { r(3, -4, 10, 2, "#2d2a4a"); r(5, -7, 6, 3, "#2d2a4a"); r(5, -7, 3, 1, HI); }
    // Objet tenu
    if (item === "hammer") { const up = frame ? 3 : 0; r(13, 4 - up, 1, 8, WOOD); r(11, 2 - up, 5, 3, "#9aa0ab"); r(11, 2 - up, 5, 1, HI2); r(11, 4 - up, 5, 1, SH2); }
    if (item === "book") { r(11, 8, 5, 4, "#7a2a20"); r(12, 9, 3, 2, "#f5e9c8"); r(11, 8, 1, 4, "rgba(0,0,0,.25)"); }
    if (item === "shield") { r(0, 5, 4, 6, "#3a5fa0"); r(1, 6, 2, 4, "#ffd37a"); r(0, 5, 4, 1, HI2); r(3, 6, 1, 5, SH); }
    sprite(c, x, y, L);
    // Arme équipée (butin ou échange) : « weapon:<type>:<rareté> », tenue à la main droite (dessinée par-dessus le personnage)
    if (typeof item === "string" && item.startsWith("weapon:")) { const [, wt, wg] = item.split(":"); weapon(c, x + 7, y - 1, wt, wg, 1); }
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
    queen: { hair: "#3a2a1c", tunic: "#4a2f8a", apron: "#e8e4da", hat: "crown", skin: "#f2c9a0" },
    noble: { hair: "#222", tunic: "#2f6a8a", apron: "#c9c4b0", skin: "#d9a066" },
    armurier: { hair: "#3a2a1c", tunic: "#7a2f2f", apron: "#4a4a52", skin: "#d9a066", hat: "helmet", beard: true, item: "weapon:axe:epic" },
    architecte: { hair: "#7a5a3a", tunic: "#2a7f86", apron: "#d8cfa8", skin: "#e0b088", hat: "copper", beard: true },
  };

  /** Sol, murs, tapis, torches et porte d'une salle de w x h tuiles. */
  function room(c, t, w, h) {
    roomShell(c, t, w, h, "forge");
    const cx = Math.floor(w / 2) - 4;
    carpetRug(c, cx, 4, 8, h - 5, "#5a2f3a", "#6e3a47", "#c9a35b");
    doorBottom(c, Math.floor(w / 2) - 1, h);
    [0, w - 1, cx - 2, cx + 9].forEach((tx, i) => torch(c, tx, 2, t + i));
  }
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
    c.fillStyle = "rgba(255,160,70,.07)"; c.beginPath(); c.arc(x + 8, y + 8, 22, 0, Math.PI * 2); c.fill();
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
      c.fillStyle = "rgba(255,150,60,.09)"; c.beginPath(); c.arc(x + 32, y + 38, 38, 0, Math.PI * 2); c.fill();
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
    if (on) { c.fillStyle = "rgba(125,212,255,.10)"; c.beginPath(); c.arc(x + 8, y + 16, 20, 0, Math.PI * 2); c.fill(); }
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
    }
  }
  /** Porte magique dans le mur du fond de la forge, qui mène à une salle (2 x 2 tuiles à partir de (tx, ty)). */
  function hubDoor(c, tx, ty, t = 0) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [[0, 0, 32, 32, "#6e6a7a"], [2, 2, 28, 30, "#4a4756"], [0, 0, 32, 1, HI2], [0, 0, 2, 32, HI], [30, 0, 2, 32, SH], [5, 6, 22, 26, "#1b1430"], [5, 6, 22, 2, "rgba(0,0,0,.4)"],
      [3, 0, 26, 4, "#8a8698"], [3, 0, 26, 1, HI2], [11, -2, 10, 3, "#a9a6b4"], [14, 0, 4, 2, "#8a6aff"]]);
    for (let i = 0; i < 4; i++) { const f = Math.floor(t * 3 + i) % 3; px(c, x + 8 + i * 5, y + 9 + f * 6, 2, 3, "#8a6aff"); px(c, x + 10 + i * 4, y + 12 + ((f + 1) % 3) * 5, 1, 2, "#c4b0ff"); }
    c.fillStyle = "rgba(138,106,255,.10)"; c.beginPath(); c.arc(x + 16, y + 22, 26, 0, Math.PI * 2); c.fill();
  }

  const CLOTH = {
    red: ["#7a2a3a", "#9a3a4c", "#f0d078"], blue: ["#2a3f7a", "#3a56a0", "#f0d078"], green: ["#2a6a4a", "#3a8a60", "#f0d078"],
    purple: ["#5a2a7a", "#7a3aa0", "#f0d078"], gold: ["#b8903a", "#d8b04a", "#fff0b0"],
  };
  const OBJECT_NAME = { throne: "Trône", statue: "Statue", table: "Table", chest: "Coffre", window: "Fenêtre", bookshelf: "Bibliothèque" };

  /** Tapis : posé au sol, sous les meubles. */
  function carpet(c, tx, ty, w, h, color) {
    const [a, b, e] = CLOTH[color] || CLOTH.red, X = tx * T, Y = ty * T, Hd = h * T;
    carpetRug(c, tx, ty, w, h, a, b, e);
    for (let i = 0; i < w * 2; i++) px(c, X + 2 + i * 8, Y + Hd, 3, 2, e);
  }
  function pillar(c, tx, ty) {
    const x = tx * T, y = ty * T;
    sprite(c, x, y, [
      [2, 27, 12, 5, "#8a8794"], [2, 27, 12, 1, "#b9b6c4"], [3, 5, 10, 22, "#a9a6b4"], [10, 5, 3, 22, "#8a8794"], [4, 5, 2, 22, "#c8c5d2"],
      [7, 6, 1, 20, "rgba(0,0,0,.1)", true], [1, 1, 14, 5, "#b9b6c4"], [1, 1, 14, 1, HI2], [1, 5, 14, 1, "#8a8794"], [2, 29, 12, 3, SH],
    ]);
  }
  function statue(c, tx, ty) {
    const x = tx * T, y = ty * T;
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
      default: return crate(c, o.x, o.y);
    }
  }

  window.ForgeSprites = { T, px, GRADE, TYPES, weapon, icon, person, LOOKS, room, roomShell, doorBottom, ironGate, hubDoor, drawObject, OBJECT_NAME, torch, furnace, anvil, board, stone, rack, stall, barrel, crate, sparks, sparkle, pointer };
})();
