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

  /** Une arme dans une grille de 12 x 12, agrandie par `s`. Les légendaires brillent. */
  function weapon(c, x, y, type, grade, s = 1) {
    const g = GRADE[grade] || GRADE.common;
    const r = (dx, dy, w, h, col) => px(c, x + dx * s, y + dy * s, w * s, h * s, col);
    if (grade === "legendary") r(-1, -1, 14, 14, "rgba(255,200,80,.22)");
    switch (type) {
      case "axe": r(5, 2, 2, 10, WOOD); r(1, 1, 5, 5, g.c); r(1, 1, 2, 5, g.d); r(0, 2, 1, 3, g.c); break;
      case "hammer": r(5, 3, 2, 9, WOOD); r(2, 0, 8, 4, g.c); r(2, 0, 8, 1, "#ffffff55"); r(2, 3, 8, 1, g.d); break;
      case "dagger": r(5, 2, 2, 5, g.c); r(4, 7, 4, 1, g.d); r(5, 8, 2, 3, WOOD); break;
      case "spear": r(5, 3, 2, 9, WOOD); r(4, 1, 4, 2, g.c); r(5, 0, 2, 1, g.c); r(4, 3, 4, 1, g.d); break;
      case "bow": r(8, 0, 1, 2, WOOD); r(9, 2, 1, 3, WOOD); r(10, 5, 1, 2, WOOD); r(9, 7, 1, 3, WOOD); r(8, 10, 1, 2, WOOD); r(7, 1, 1, 10, "#ddd"); r(3, 5, 6, 1, g.c); r(2, 4, 2, 3, g.d); break;
      case "staff": r(5, 3, 2, 9, WOOD); r(4, 0, 4, 4, g.c); r(5, 1, 1, 1, "#fff"); break;
      default: r(5, 0, 2, 8, g.c); r(5, 0, 1, 8, "#ffffff66"); r(3, 8, 6, 1, g.d); r(5, 9, 2, 3, WOOD); // épée
    }
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
    px(c, x + 3, yb - 2, 10, 2, "rgba(0,0,0,.25)");
    if (cape) px(c, x + 3, yb - 12, 10, 9, cape);
    px(c, x + 5, yb - 4 + (frame === 1 ? 1 : 0), 2, frame === 1 ? 3 : 4, "#3b3a47");
    px(c, x + 9, yb - 4 + (frame === 2 ? 1 : 0), 2, frame === 2 ? 3 : 4, "#3b3a47");
    px(c, x + 4, yb - 11, 8, 8, tunic);
    if (dir !== "up") px(c, x + 5, yb - 9, 6, 6, apron);
    px(c, x + 2, yb - 11, 2, 6, tunic); px(c, x + 12, yb - 11, 2, 6, tunic);
    px(c, x + 2, yb - 5, 2, 2, skin); px(c, x + 12, yb - 5, 2, 2, skin);
    px(c, x + 4, yb - 18, 8, 7, skin);
    if (!bald) {
      px(c, x + 4, yb - 18, 8, dir === "up" ? 7 : 3, hair);
      if (dir !== "up") { px(c, x + 3, yb - 17, 1, 4, hair); px(c, x + 12, yb - 17, 1, 4, hair); }
    }
    if (dir === "down") { px(c, x + 6, yb - 14, 1, 2, "#23252b"); px(c, x + 9, yb - 14, 1, 2, "#23252b"); }
    if (dir === "left") px(c, x + 5, yb - 14, 1, 2, "#23252b");
    if (dir === "right") px(c, x + 10, yb - 14, 1, 2, "#23252b");
    if (beard) { px(c, x + 4, yb - 13, 8, 4, "#e8e4da"); px(c, x + 6, yb - 12, 4, 1, skin); }
    if (hat === "cap") { px(c, x + 3, yb - 20, 10, 3, "#9a3b2e"); px(c, x + 3, yb - 18, 10, 1, "#7a2a20"); }
    if (hat === "helmet") { px(c, x + 3, yb - 20, 10, 4, "#9aa0ab"); px(c, x + 7, yb - 23, 2, 3, "#c0392b"); px(c, x + 3, yb - 17, 10, 1, "#5d626c"); }
    if (hat === "copper") { px(c, x + 3, yb - 20, 10, 4, "#c97c3a"); px(c, x + 3, yb - 17, 10, 1, "#8a4a1c"); px(c, x + 7, yb - 21, 2, 2, "#e8a05a"); }
    if (hat === "turban") { px(c, x + 3, yb - 21, 10, 5, "#2f9a6a"); px(c, x + 6, yb - 23, 4, 2, "#2f9a6a"); px(c, x + 7, yb - 20, 2, 1, "#ffd37a"); }
    if (hat === "scribe") { px(c, x + 3, yb - 20, 10, 2, "#2d2a4a"); px(c, x + 5, yb - 23, 6, 3, "#2d2a4a"); }
    if (item === "hammer") { const up = frame ? 3 : 0; px(c, x + 13, yb - 12 - up, 1, 8, WOOD); px(c, x + 11, yb - 14 - up, 5, 3, "#9aa0ab"); }
    if (item === "book") { px(c, x + 11, yb - 8, 5, 4, "#7a2a20"); px(c, x + 12, yb - 7, 3, 2, "#f5e9c8"); }
    if (item === "shield") { px(c, x, yb - 11, 4, 6, "#3a5fa0"); px(c, x + 1, yb - 10, 2, 4, "#ffd37a"); }
  }

  const LOOKS = {
    brann: { hair: "#e8e4da", tunic: "#8a3b12", apron: "#4a3a2a", skin: "#e0b088", beard: true, bald: true },
    apprenti: { hair: "#3a2a1c", tunic: "#3e9a6a", apron: "#6b4423", hat: "cap" },
    apprenti2: { hair: "#23252b", tunic: "#b0503e", apron: "#6b4423", hat: "cap" },
    apprenti3: { hair: "#8a3b12", tunic: "#8a5cb0", apron: "#6b4423", hat: "cap" },
    gardien: { hair: "#3a2a1c", tunic: "#3a5fa0", apron: "#9aa0ab", hat: "helmet", item: "shield" },
    scribe: { hair: "#8a5a3a", tunic: "#4a3a7a", apron: "#d8cfa8", hat: "scribe", item: "book", skin: "#d9a066" },
    marchand: { hair: "#222", tunic: "#2f7a5a", apron: "#d8b04a", hat: "turban", skin: "#d9a066" },
  };

  /** Sol, murs, tapis, torches et porte d'une salle de w x h tuiles. */
  function room(c, t, w, h) {
    for (let y = 3; y < h - 1; y++) for (let x = 0; x < w; x++) {
      px(c, x * T, y * T, T, T, (x + y) % 2 ? "#4b4452" : "#453e4c");
      if ((x * 7 + y * 13) % 11 === 0) px(c, x * T + 4, y * T + 5, 3, 2, "#3b3542");
    }
    for (let y = 0; y < 3; y++) for (let x = 0; x < w; x++) {
      px(c, x * T, y * T, T, T, "#2b2732"); px(c, x * T, y * T + T - 1, T, 1, "#1d1a22"); px(c, x * T + (y % 2 ? 8 : 0), y * T, 1, T - 1, "#1d1a22");
    }
    for (let x = 0; x < w; x++) px(c, x * T, (h - 1) * T, T, T, "#2b2732");
    const cx = Math.floor(w / 2) - 4;
    px(c, cx * T, 4 * T, 8 * T, (h - 5) * T, "#5a2f3a"); px(c, cx * T + 3, 4 * T + 3, 8 * T - 6, (h - 5) * T - 6, "#6e3a47");
    px(c, cx * T, 4 * T, 8 * T, 2, "#c9a35b"); px(c, cx * T, (h - 1) * T - 2, 8 * T, 2, "#c9a35b");
    const dx = Math.floor(w / 2) - 1;
    px(c, dx * T - 4, (h - 1) * T - 4, 2 * T + 8, T + 4, "#3a2a1c"); px(c, dx * T, (h - 1) * T, 2 * T, T, "#7a4a1c"); px(c, dx * T + T - 1, (h - 1) * T, 2, T, "#4a2a10"); px(c, dx * T + 4, (h - 1) * T + 8, 3, 3, "#ffd37a");
    px(c, dx * T, (h - 1) * T - 2, 2 * T, 2, "#ffe9a0");
    [0, w - 1, cx - 2, cx + 9].forEach((tx, i) => torch(c, tx, 2, t + i));
  }
  function torch(c, tx, ty, t) {
    const x = tx * T, y = ty * T, f = Math.floor(t * 6) % 3;
    px(c, x + 6, y + 6, 4, 8, WOOD2); px(c, x + 4, y + 4, 8, 3, "#444");
    px(c, x + 5, y - 1 - (f === 1 ? 1 : 0), 6, 6, "#ff7a1a"); px(c, x + 6, y + 1 - (f === 2 ? 1 : 0), 4, 4, "#ffc83d");
    c.fillStyle = "rgba(255,160,70,.07)"; c.beginPath(); c.arc(x + 8, y + 8, 22, 0, Math.PI * 2); c.fill();
  }
  /** Four de 4 x 3 tuiles ; allumé (flammes qui dansent) ou éteint (cendres). */
  function furnace(c, tx, ty, lit, t = 0) {
    const x = tx * T, y = ty * T;
    px(c, x + 40, y - 14, 14, 18, "#4a4752");
    px(c, x, y, 64, 48, "#5d5a66");
    for (let i = 1; i < 4; i++) px(c, x, y + i * 12, 64, 1, "#434650");
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) px(c, x + ((j + i) % 2 ? 10 : 26) + i * 16 - 16, y + j * 12 + 1, 1, 11, "#434650");
    px(c, x + 14, y + 16, 36, 26, "#18120e"); px(c, x + 12, y + 14, 40, 2, "#3a3744");
    if (lit) {
      const f = Math.floor(t * 7) % 3;
      px(c, x + 18, y + 26 - f, 8, 14 + f, "#ff7a1a"); px(c, x + 28, y + 22 + f, 8, 18 - f, "#ff9a2a"); px(c, x + 38, y + 28, 8, 12, "#ff7a1a");
      px(c, x + 22, y + 32, 6, 8, "#ffc83d"); px(c, x + 32, y + 30, 6, 10, "#ffd96a");
      c.fillStyle = "rgba(255,150,60,.09)"; c.beginPath(); c.arc(x + 32, y + 38, 38, 0, Math.PI * 2); c.fill();
    } else {
      px(c, x + 18, y + 38, 28, 4, "#2a2622"); px(c, x + 24, y + 36, 6, 2, "#3a3430");
    }
  }
  function anvil(c, tx, ty) {
    const x = tx * T, y = ty * T;
    px(c, x + 2, y + 6, 14, 3, "#a3a9b5"); px(c, x + 2, y + 9, 12, 2, "#7d838f"); px(c, x + 5, y + 11, 6, 2, "#7d838f"); px(c, x + 3, y + 13, 10, 3, "#6a707c"); px(c, x + 15, y + 7, 3, 2, "#7d838f");
  }
  function board(c, tx, ty) {
    const x = tx * T, y = ty * T;
    px(c, x, y, 32, 28, "#4a2f18"); px(c, x + 2, y + 2, 28, 24, "#8a6a3a");
    px(c, x + 5, y + 5, 9, 11, "#f5e9c8"); px(c, x + 17, y + 6, 9, 9, "#f0e0b0"); px(c, x + 8, y + 16, 12, 8, "#f5e9c8");
    px(c, x + 9, y + 3, 2, 3, "#c0392b"); px(c, x + 21, y + 4, 2, 3, "#2f6fb0");
    px(c, x + 6, y + 8, 6, 1, "#7a6a4a"); px(c, x + 6, y + 11, 6, 1, "#7a6a4a"); px(c, x + 19, y + 9, 6, 1, "#7a6a4a");
    px(c, x + 4, y + 28, 3, 6, WOOD2); px(c, x + 25, y + 28, 3, 6, WOOD2);
  }
  /** Pierre d'éveil : ses runes brillent en bleu quand Claude est connecté. */
  function stone(c, tx, ty, on, t = 0) {
    const x = tx * T, y = ty * T;
    px(c, x + 2, y + 6, 12, 22, "#7a7d88"); px(c, x + 4, y + 2, 8, 6, "#8a8d98"); px(c, x + 2, y + 24, 12, 4, "#5d606a");
    const col = on ? "#7dd4ff" : "#4a5060", p = on ? 1 + (Math.floor(t * 3) % 2) : 1;
    px(c, x + 7, y + 8, 2, 4 * p, col); px(c, x + 5, y + 14, 6, 1, col); px(c, x + 6, y + 17, 1, 3, col); px(c, x + 9, y + 17, 1, 3, col);
    if (on) { c.fillStyle = "rgba(125,212,255,.10)"; c.beginPath(); c.arc(x + 8, y + 16, 20, 0, Math.PI * 2); c.fill(); }
  }
  /** Râtelier de 6 x 2 tuiles garni d'armes [type, qualité]. */
  function rack(c, tx, ty, list) {
    const x = tx * T, y = ty * T, w = 6 * T;
    px(c, x, y, w, 36, "#5a3d24"); px(c, x + 3, y + 3, w - 6, 30, "#6e4a2c");
    px(c, x, y + 14, w, 3, "#3e2a18"); px(c, x, y + 33, w, 3, "#3e2a18"); px(c, x, y, 4, 40, "#3e2a18"); px(c, x + w - 4, y, 4, 40, "#3e2a18");
    list.slice(0, 6).forEach((it, i) => weapon(c, x + 8 + i * 14, y + 3 + (i % 2) * 17, it[0], it[1], 1));
    px(c, x + 6, y + 40, w - 12, 2, "rgba(0,0,0,.25)");
  }
  function stall(c, tx, ty) {
    const x = tx * T, y = ty * T, w = 6 * T;
    for (let i = 0; i < 12; i++) px(c, x + i * 8, y, 8, 12, i % 2 ? "#f5f0e1" : "#2f9a6a");
    px(c, x, y + 12, w, 2, "#1f6a48"); px(c, x + 2, y + 14, 3, 30, WOOD2); px(c, x + w - 5, y + 14, 3, 30, WOOD2);
    px(c, x, y + 32, w, 14, "#7a4a1c"); px(c, x, y + 32, w, 3, "#a06a2c"); px(c, x, y + 46, w, 2, "#4a2a10");
    px(c, x + 8, y + 26, 5, 6, "#ffd37a"); px(c, x + 15, y + 28, 5, 4, "#ffd37a"); px(c, x + 60, y + 25, 6, 7, "#c0392b"); px(c, x + 70, y + 27, 6, 5, "#4f8bff");
  }
  function barrel(c, tx, ty) { const x = tx * T, y = ty * T; px(c, x + 2, y + 2, 12, 14, "#7a4a1c"); px(c, x + 2, y + 5, 12, 1, "#3e2a18"); px(c, x + 2, y + 11, 12, 1, "#3e2a18"); px(c, x + 3, y, 10, 3, "#8a5a2c"); }
  function crate(c, tx, ty) { const x = tx * T, y = ty * T; px(c, x + 1, y + 3, 14, 13, "#8a5a2c"); px(c, x + 1, y + 3, 14, 1, "#a06a2c"); px(c, x + 7, y + 3, 2, 13, "#5a3a1c"); px(c, x + 1, y + 9, 14, 1, "#5a3a1c"); }
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

  window.ForgeSprites = { T, px, GRADE, TYPES, weapon, icon, person, LOOKS, room, furnace, anvil, board, stone, rack, stall, barrel, crate, sparks, sparkle, pointer };
})();
