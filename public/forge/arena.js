/* Jouer à l'arène : le calque plein écran, les touches, le dessin en pixel art et les écrans d'intro et de fin.
   La logique du combat est dans combat.js (aucun code d'utilisateur ne s'exécute : ce sont les bots et les règles de la forge). */
(() => {
  "use strict";
  const S = window.ForgeSprites, C = window.ForgeCombat;
  const T = C.T, W = C.W, H = C.H;
  const px = (c, x, y, w, h, col) => S.px(c, Math.round(x), Math.round(y), w, h, col);
  const pct = (v) => `${Math.round(v * 100)} %`;
  const round2 = (v) => String(Math.round(v * 100) / 100).replace(".", ",");

  /** Apparence des bots (les mêmes pièces de dessin que les personnages de la forge). `scale` : taille entière du dessin. */
  const BOT_LOOKS = {
    gobelin: { skin: "#6aa84f", hair: "#2f5a2a", tunic: "#6b4a2a", apron: "#4a3a2a", hat: "bandana", bald: true, ears: true },
    soldat: { skin: "#e0b088", hair: "#3a2a1c", tunic: "#8a2a2a", apron: "#9aa0ab", hat: "helmet" },
    brute: { skin: "#c88a60", hair: "#3a2a1c", tunic: "#5a4a3a", apron: "#3a2a1c", hat: "viking", beard: true },
    archer: { skin: "#d9a066", hair: "#8a3b12", tunic: "#2f7a5a", apron: "#6b4423", hat: "feather" },
    mage: { skin: "#e0b088", hair: "#e8e4da", tunic: "#4a3f9a", apron: "#f0d078", hat: "wizard", beard: true },
    seigneur: { skin: "#c88a60", hair: "#3a2a1c", tunic: "#7a1f2e", apron: "#f0d078", hat: "crown", beard: true, scale: 2 },
    assassin: { skin: "#d9a066", hair: "#23252b", tunic: "#2a2a38", apron: "#1d1d28", hat: "scribe" },
    colosse: { skin: "#9a9aa6", hair: "#6a6a76", tunic: "#55555f", apron: "#3a3a44", hat: "viking", beard: true, bald: true, scale: 2 },
    archimage: { skin: "#d8c7e8", hair: "#ffffff", tunic: "#5a2f9a", apron: "#c9a3ff", hat: "wizard", beard: true, scale: 2 },
  };
  const SFX = { swing: "blip", "swing-hit": "hammer", hit: "hammer", crit: "coin", shoot: "blip", "bot-shoot": "blip", hurt: "error", kill: "bump", dash: "step", wave: "spawn", clear: "coin", win: "fanfare", lose: "error", summon: "spawn", charge: "bump", shock: "bump" };

  const dirOf = (f) => (Math.abs(f[0]) > Math.abs(f[1]) ? (f[0] < 0 ? "left" : "right") : f[1] < 0 ? "up" : "down");

  /* ---------- décor : un sable ratissé, une palissade cerclée de fer, des boucliers, des braziers, la foule en haut ---------- */
  // Le canevas de l'arène est en double résolution (voir `start`) : les valeurs en demis donnent des détails deux fois plus fins que les personnages.
  const BRAZIERS = [[8, 62], [8, 196], [376, 62], [376, 196]];
  function drawStatic(c) {
    const fx = S.fx, hash = S.hash, half = S.half;
    fx(c, 0, 0, W * T, H * T, "#241810");
    // Sable : deux teintes en damier, variation de chaque case, grains, cailloux
    for (let ty = 2; ty < 14; ty++) for (let tx = 1; tx < 23; tx++) {
      const X = tx * T, Y = ty * T, r = hash(tx * 7 + 1, ty * 13 + 5);
      px(c, X, Y, T, T, (tx + ty) % 2 ? "#d1ae72" : "#c9a56a");
      fx(c, X, Y, T, T, r < 0.5 ? `rgba(255,240,200,${(0.02 + r * 0.06).toFixed(3)})` : `rgba(90,60,20,${(0.02 + (r - 0.5) * 0.08).toFixed(3)})`);
      for (let k = 0; k < 8; k++) fx(c, half(X + hash(tx * 17 + k, ty * 5) * 15.5), half(Y + hash(tx * 3, ty * 19 + k) * 15.5), 0.5, 0.5, k % 3 ? "rgba(120,85,40,.35)" : "rgba(255,245,215,.4)");
      if (r > 0.9) { const gx = half(X + 3 + hash(tx, ty) * 9), gy = half(Y + 3 + hash(ty, tx) * 9); fx(c, gx, gy, 2, 1.5, "#a9854f"); fx(c, gx, gy, 2, 0.5, "rgba(255,255,255,.28)"); fx(c, gx + 0.5, gy + 1.5, 1.5, 0.5, "rgba(0,0,0,.22)"); }
    }
    // Ratissage : des cercles concentriques d'un demi-pixel, un trait sombre et son reflet
    c.save(); c.lineWidth = 0.5;
    for (const [rx, ry, a] of [[70, 56, 0.11], [86, 68, 0.09], [104, 80, 0.07], [124, 94, 0.05]]) {
      c.strokeStyle = `rgba(110,75,35,${a})`; c.beginPath(); c.ellipse(192, 128, rx, ry, 0, 0, Math.PI * 2); c.stroke();
      c.strokeStyle = `rgba(255,245,215,${a})`; c.beginPath(); c.ellipse(192, 128.5, rx, ry, 0, 0, Math.PI * 2); c.stroke();
    }
    // Cercle d'honneur : double anneau, rayons, épées croisées gravées au centre
    c.strokeStyle = "rgba(90,60,25,.6)"; c.lineWidth = 1; c.beginPath(); c.ellipse(192, 128, 52, 42, 0, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 0.5; c.strokeStyle = "rgba(90,60,25,.45)"; c.beginPath(); c.ellipse(192, 128, 44, 35, 0, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = "rgba(255,245,215,.35)"; c.beginPath(); c.ellipse(192, 128.5, 52, 42, 0, 0, Math.PI * 2); c.stroke();
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; c.strokeStyle = "rgba(90,60,25,.4)"; c.beginPath(); c.moveTo(192 + Math.cos(a) * 44, 128 + Math.sin(a) * 35); c.lineTo(192 + Math.cos(a) * 52, 128 + Math.sin(a) * 42); c.stroke(); }
    c.lineWidth = 1.2; c.strokeStyle = "rgba(90,60,25,.38)";
    c.beginPath(); c.moveTo(180, 118); c.lineTo(204, 138); c.moveTo(204, 118); c.lineTo(180, 138); c.stroke();
    c.lineWidth = 2; c.beginPath(); c.moveTo(178, 120); c.lineTo(182, 116); c.moveTo(206, 120); c.lineTo(202, 116); c.stroke();
    c.restore();
    // Traces de pas et marques de lames dans le sable
    for (const [x, y] of [[90, 90], [112, 170], [260, 80], [300, 150], [150, 200], [220, 190]]) { fx(c, x, y, 1.5, 2.5, "rgba(110,75,35,.28)"); fx(c, x + 3, y + 2, 1.5, 2.5, "rgba(110,75,35,.28)"); fx(c, x + 0.5, y + 0.5, 1, 0.5, "rgba(255,245,215,.25)"); }
    // Palissade : planches veinées, bandes de fer rivetées, sommet éclairé
    const plank = (x, y, w, h) => {
      px(c, x, y, w, h, "#5a3a22");
      const vertical = h > w;
      for (let i = 0; i < Math.max(w, h); i += 8) {
        const r = hash(i + x, y + 3);
        if (vertical) { fx(c, x, y + i, w, 8, r < 0.5 ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.08)"); fx(c, x, y + i, w, 0.5, "#2e1d10"); fx(c, x, y + i + 0.5, w, 0.5, "rgba(255,200,140,.12)"); for (let g = 0; g < 3; g++) fx(c, x + 2 + g * 4.5, y + i + 1 + hash(i, g) * 5, 0.5, 2 + hash(g, i) * 3, "rgba(0,0,0,.18)"); }
        else { fx(c, x + i, y, 8, h, r < 0.5 ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.08)"); fx(c, x + i, y, 0.5, h, "#2e1d10"); fx(c, x + i + 0.5, y, 0.5, h, "rgba(255,200,140,.12)"); for (let g = 0; g < 4; g++) fx(c, x + i + 1 + hash(i, g) * 5, y + 2 + g * 7, 2 + hash(g, i) * 3, 0.5, "rgba(0,0,0,.18)"); }
      }
    };
    plank(0, 0, W * T, 2 * T); plank(0, 0, T, H * T); plank(23 * T, 0, T, H * T); plank(0, 14 * T, W * T, T);
    // Bandes de fer et rivets
    const band = (x, y, w, h) => { fx(c, x, y, w, h, "#3a3a44"); fx(c, x, y, w, 0.5, "rgba(255,255,255,.18)"); fx(c, x, y + h - 0.5, w, 0.5, "rgba(0,0,0,.4)"); for (let i = 3; i < Math.max(w, h) - 2; i += 11) { const rx = w > h ? x + i : x + w / 2 - 0.5, ry = w > h ? y + h / 2 - 0.5 : y + i; fx(c, rx, ry, 1.5, 1.5, "#7d838f"); fx(c, rx, ry, 1.5, 0.5, "rgba(255,255,255,.4)"); } };
    band(0, 2 * T - 8, W * T, 3); band(0, 12, W * T, 2.5); band(0, 14 * T + 4, W * T, 3); band(3, 0, 2.5, H * T); band(23 * T + 10.5, 0, 2.5, H * T);
    fx(c, T, 2 * T - 3, 22 * T, 3, "#2a1d12");
    // Profondeur : l'ombre douce de la palissade sur le sable
    let g = c.createLinearGradient(0, 2 * T, 0, 2 * T + 12); g.addColorStop(0, "rgba(40,22,8,.5)"); g.addColorStop(1, "rgba(40,22,8,0)"); c.fillStyle = g; c.fillRect(T, 2 * T, 22 * T, 12);
    g = c.createLinearGradient(T, 0, T + 10, 0); g.addColorStop(0, "rgba(40,22,8,.45)"); g.addColorStop(1, "rgba(40,22,8,0)"); c.fillStyle = g; c.fillRect(T, 2 * T, 10, 12 * T);
    g = c.createLinearGradient(23 * T - 10, 0, 23 * T, 0); g.addColorStop(0, "rgba(40,22,8,0)"); g.addColorStop(1, "rgba(40,22,8,.45)"); c.fillStyle = g; c.fillRect(23 * T - 10, 2 * T, 10, 12 * T);
    g = c.createLinearGradient(0, 14 * T - 10, 0, 14 * T); g.addColorStop(0, "rgba(40,22,8,0)"); g.addColorStop(1, "rgba(40,22,8,.5)"); c.fillStyle = g; c.fillRect(T, 14 * T - 10, 22 * T, 10);
    // Bannières rouges : plis, franges, tringle
    for (const x of [3, 8, 15, 20]) {
      px(c, x * T + 3, 0, 10, 20, "#9a2a2a"); px(c, x * T + 3, 0, 10, 2, "#c8aa4a"); px(c, x * T + 6, 6, 4, 4, "#f0d078"); px(c, x * T + 3, 18, 3, 2, "#2a1d12"); px(c, x * T + 10, 18, 3, 2, "#2a1d12");
      fx(c, x * T + 3, 2, 0.5, 16, "rgba(255,255,255,.12)"); fx(c, x * T + 8, 2, 0.5, 16, "rgba(0,0,0,.18)"); fx(c, x * T + 12.5, 2, 0.5, 16, "rgba(0,0,0,.25)");
      fx(c, x * T + 7.5, 7, 1, 2, "#9a2a2a"); fx(c, x * T + 3, 19, 10, 0.5, "rgba(0,0,0,.3)");
    }
    // Boucliers et lames accrochés aux murs de côté, supports des braziers
    for (const [sx, sy, col] of [[8, 104, "#3a5fa0"], [8, 144, "#9a2a2a"], [376, 104, "#9a2a2a"], [376, 144, "#3a5fa0"]]) {
      c.fillStyle = "#1d1814"; c.beginPath(); c.arc(sx, sy, 6.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = col; c.beginPath(); c.arc(sx, sy, 5.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = "rgba(255,255,255,.2)"; c.beginPath(); c.arc(sx - 1.2, sy - 1.5, 3.8, Math.PI * 0.9, Math.PI * 1.7); c.lineTo(sx - 1.2, sy - 1.5); c.fill();
      c.strokeStyle = "#c8aa4a"; c.lineWidth = 0.8; c.beginPath(); c.arc(sx, sy, 5.5, 0, Math.PI * 2); c.stroke();
      fx(c, sx - 1.5, sy - 1.5, 3, 3, "#c8ced8"); fx(c, sx - 1.5, sy - 1.5, 3, 0.5, "#fff");
    }
    for (const [bx, by] of BRAZIERS) {
      S.softShadow(c, bx, by + 10, 8, 3, 0.3);
      fx(c, bx - 1.5, by + 3, 3, 8, "#2e2e36"); fx(c, bx - 4, by + 9, 8, 2, "#2e2e36"); fx(c, bx - 4, by + 9, 8, 0.5, "rgba(255,255,255,.2)");
      fx(c, bx - 5, by, 10, 4, "#4a4a55"); fx(c, bx - 5, by, 10, 1, "#8a909c"); fx(c, bx - 5, by + 3.5, 10, 0.5, "rgba(0,0,0,.45)"); fx(c, bx - 4, by - 0.5, 8, 1.5, "#241006");
    }
  }
  /** Foule et flammes : deux rangs de spectateurs qui ondulent et lèvent les bras, des torches et des braziers qui tremblent et éclairent. */
  function drawCrowd(c, t) {
    const COLORS = ["#d9a066", "#f2c9a0", "#8d5a3b", "#c88a60"], CLOTH = ["#3e6fb0", "#b0503e", "#3e9a6a", "#8a5cb0", "#d8a63a"];
    // Rang du fond : plus petit et plus sombre
    for (let i = 0; i < 24; i++) {
      const x = 12 + i * 15.5 + ((i * 3) % 5), bob = Math.sin(t * 2.4 + i * 2.3) * 0.8;
      S.fx(c, x, 13 + bob, 5, 4, CLOTH[(i + 2) % CLOTH.length]); S.fx(c, x + 0.5, 9.5 + bob, 4, 4, COLORS[(i + 1) % COLORS.length]); S.fx(c, x, 13 + bob, 5, 4, "rgba(0,0,0,.35)"); S.fx(c, x + 0.5, 9.5 + bob, 4, 0.5, "#2a1d12");
    }
    for (let i = 0; i < 17; i++) {
      const x = 22 + i * 21 + ((i * 5) % 7), bob = Math.round(Math.sin(t * 3 + i * 1.7) * 1.2), cheer = Math.floor(t * 1.5 + i * 0.37) % 6 === 0;
      px(c, x, 20 + bob, 7, 6, CLOTH[i % CLOTH.length]); px(c, x + 1, 15 + bob, 5, 5, COLORS[i % COLORS.length]); px(c, x + 1, 15 + bob, 5, 1, "#2a1d12");
      S.fx(c, x + 2, 17.5 + bob, 0.5, 1, "#23252b"); S.fx(c, x + 4, 17.5 + bob, 0.5, 1, "#23252b"); S.fx(c, x, 20 + bob, 7, 0.5, "rgba(255,255,255,.18)");
      if (cheer) { S.fx(c, x - 1, 13 + bob, 1.5, 6, COLORS[i % COLORS.length]); S.fx(c, x + 6.5, 13 + bob, 1.5, 6, COLORS[i % COLORS.length]); }
    }
    for (const x of [6, 12, 18]) {
      const f = Math.floor(t * 8 + x) % 2;
      px(c, x * T + 6, 8, 3, 8, "#3b2616"); px(c, x * T + 5, 3 + f, 5, 5, "#ff9a2a"); px(c, x * T + 6, 4 + f, 3, 3, "#ffd37a"); S.fx(c, x * T + 7, 5 + f, 1, 1.5, "#fff3b0");
      S.glow(x * T + 7.5, 7, 30, "255,150,60", 0.3);
    }
    for (const [bx, by] of BRAZIERS) {
      const f = Math.floor(t * 9 + bx + by) % 3, w = 3 + (f === 1 ? 0.5 : 0);
      S.fx(c, bx - 3, by - 5 - f, 6, 5 + f, "#ff7a1a"); S.fx(c, bx - 2, by - 7 - f, 4, 4, "#ff9a2a"); S.fx(c, bx - w / 2, by - 8 - f * 0.5, w, 5, "#ffd37a"); S.fx(c, bx - 0.5, by - 4, 1, 3, "#fff3b0");
      S.glow(bx, by - 3, 46, "255,140,50", 0.34);
    }
  }

  /* ---------- objets dessinés par-dessus ---------- */
  function drawPillar(c, o) {
    S.drawObject(c, { type: "pillar", x: o.x / T, y: o.y / T - 1 }, 0);
  }
  function drawSlash(c, f) {
    const k = f.t / f.life, [dx, dy] = f.dir, base = Math.atan2(dy, dx), half = (f.arc / 2) * Math.PI / 180;
    const col = f.bot ? "rgba(255,140,120," : "rgba(255,246,200,";
    c.fillStyle = col + (0.9 - k * 0.6) + ")";
    const steps = Math.max(4, Math.round(f.arc / 14));
    for (let i = 0; i <= steps; i++) {
      const a = base - half + (half * 2 * i) / steps, r = 8 + f.reach * (0.6 + k * 0.4);
      c.fillRect(Math.round(f.x + Math.cos(a) * r), Math.round(f.y + Math.sin(a) * r), 3, 3);
    }
  }
  function drawShot(c, s) {
    const ang = Math.atan2(s.vy, s.vx);
    if (s.kind === "arrow") {
      for (let i = 0; i < 5; i++) px(c, s.x - Math.cos(ang) * i * 1.6, s.y - Math.sin(ang) * i * 1.6, 2, 2, i === 0 ? "#e8ecf2" : "#8a6a3a");
    } else {
      const col = s.mine ? ["#ffe9a0", "#c4b0ff", "#8a6aff"] : ["#ffd0a0", "#ff9a5a", "#c0392b"];
      for (let i = 3; i >= 0; i--) px(c, s.x - Math.cos(ang) * i * 3 - 2, s.y - Math.sin(ang) * i * 3 - 2, 4 - (i > 1 ? 1 : 0), 4 - (i > 1 ? 1 : 0), col[Math.min(2, i)]);
    }
  }
  function drawBot(c, b, t) {
    const look = BOT_LOOKS[b.type], scale = look.scale ?? 1;
    const alpha = b.alive ? (b.spawnT > 0 ? 0.35 + 0.4 * Math.abs(Math.sin(t * 14)) : 1) : Math.max(0, b.dying / 0.35);
    c.globalAlpha = alpha;
    const moving = b.alive && !b.windup && b.spawnT <= 0;
    const opts = { ...look, dir: dirOf(b.face), frame: moving && Math.floor(t * 6 + b.x) % 2 ? 1 : 0, item: `weapon:${b.spec.weapon}:${b.spec.rarity}` };
    delete opts.scale;
    const feetY = b.y + b.r;
    if (scale === 1) S.person(c, Math.round(b.x - 8), Math.round(feetY - T), opts);
    else { c.save(); c.translate(Math.round(b.x), Math.round(feetY)); c.scale(scale, scale); S.person(c, -8, -T, opts); c.restore(); }
    if (b.flash > 0) { c.globalAlpha = 0.55; px(c, b.x - 5 * scale, feetY - 15 * scale, 10 * scale, 15 * scale, "#ffffff"); }
    // Ralenti par le bâton : teinte glacée et éclats bleus au sol
    if (b.alive && b.slowT > 0) {
      c.globalAlpha = 0.42; px(c, b.x - 5 * scale, feetY - 15 * scale, 10 * scale, 15 * scale, "#6ab8ff");
      c.globalAlpha = 0.85; px(c, b.x - 6 * scale, feetY - 1, 3, 2, "#bfe4ff"); px(c, b.x + 3 * scale, feetY - 2, 3, 2, "#6ab8ff");
    }
    // Brûlé : des flammes qui dansent sur la tête et les épaules
    if (b.alive && b.burn) {
      c.globalAlpha = 0.2; px(c, b.x - 5 * scale, feetY - 15 * scale, 10 * scale, 15 * scale, "#ff5a1a");
      c.globalAlpha = 0.95;
      for (let i = 0; i < 3; i++) {
        const rise = (Math.floor(t * 11 + i * 2 + b.x) % 3) * 2;
        px(c, b.x - 5 * scale + i * 4 * scale, feetY - (12 + rise) * scale, 2 * scale, 3 * scale, i === 1 ? "#ffd37a" : "#ff7a2a");
      }
    }
    c.globalAlpha = 1;
    if (!b.alive) return;
    if (b.windup > 0 && b.tell) { px(c, b.x - 1, b.y - 22 * scale, 2, 6, "#ff4a3a"); px(c, b.x - 1, b.y - 14 * scale, 2, 2, "#ff4a3a"); }
    const w = 14 * Math.min(2, scale), frac = Math.max(0, b.hp / b.maxHp);
    px(c, b.x - w / 2 - 1, b.y - 18 * scale - 3, w + 2, 4, "#1d1814"); px(c, b.x - w / 2, b.y - 18 * scale - 2, Math.round(w * frac), 2, b.spec.boss ? "#e8a05a" : "#e0453a");
  }
  function drawHero(c, fight, look, t) {
    const h = fight.hero;
    if (h.inv > 0 && h.hurt <= 0 && Math.floor(t * 16) % 2 === 0 && h.dashT <= 0) return;
    const frame = h.moving ? 1 + (Math.floor(t * 8) % 2) : 0;
    if (h.dashT > 0) { c.globalAlpha = 0.35; S.person(c, Math.round(h.x - h.dash[0] * 12 - 8), Math.round(h.y + h.r - T - h.dash[1] * 12), { ...look, dir: dirOf(h.face), frame: 1 }); c.globalAlpha = 1; }
    S.person(c, Math.round(h.x - 8), Math.round(h.y + h.r - T), { ...look, dir: dirOf(h.face), frame });
    if (h.hurt > 0) { c.globalAlpha = 0.45; px(c, h.x - 5, h.y - 10, 10, 15, "#ff3a3a"); c.globalAlpha = 1; }
  }

  /**
   * @param ctx { stage: élément qui contient le jeu, sfx, look(): apparence du joueur, onKeysCaptured(on), onFightEnd(result): applique la récompense et renvoie { gold, note } }
   * @returns { start({ built, best }) } : lance un combat, résolu quand la personne quitte (le dernier résultat).
   */
  function create(ctx) {
    let current = null; // l'arène ouverte, pour la fermer quand on quitte la forge
    function start(options) {
      return new Promise((resolve) => {
        // Le forgeron et son équipement peuvent changer sur l'écran d'introduction (choix de l'arme)
        let built = options.built, d = built.derived, w = built.weapon, equipment = options.equipment;
        const root = document.createElement("div");
        root.className = "fg-play";
        root.innerHTML = `<div class="fg-play-card" role="dialog" aria-modal="true" aria-label="L'arène">
          <div class="fg-play-top"><b>L'arène</b><span class="fg-play-hud"></span><button type="button" class="fg-x" data-play-quit aria-label="Quitter" title="Quitter (Échap)"></button></div>
          <div class="fg-play-view"><canvas width="${W * T * 2}" height="${H * T * 2}"></canvas><div class="fg-play-msg"></div></div>
          <div class="fg-play-help">Flèches ou ZQSD : bouger · Espace : frapper · Maj : roulade (tu ne peux pas être touché) · Échap : battre en retraite</div></div>`;
        ctx.stage.append(root);
        const canvas = root.querySelector("canvas"), c = canvas.getContext("2d");
        c.imageSmoothingEnabled = false;
        const hudEl = root.querySelector(".fg-play-hud"), msgEl = root.querySelector(".fg-play-msg");
        const bg = document.createElement("canvas"); bg.width = W * T * 2; bg.height = H * T * 2;
        { const bc = bg.getContext("2d"); bc.imageSmoothingEnabled = false; bc.scale(2, 2); drawStatic(bc); }
        let look = ctx.look();
        const keys = new Set();
        let fight = null, phase = "intro", raf = 0, last = 0, t = 0, acc = 0, endAt = 0, lastResult = null, runs = 0, banner = "", bannerT = 0;
        ctx.onKeysCaptured(true);
        current = quit;

        const statName = (id) => C.STATS.find((x) => x.id === id).name.toLowerCase();
        const lineText = (s) => (s.lines ?? [{ stat: s.stat, points: s.points }]).map((l) => `+${l.points} ${statName(l.stat)}`).join(", ");
        /** Les armes du sac en pastilles : on choisit ici, avant le combat (flèches gauche et droite, ou un clic). */
        function weaponPicker() {
          const all = ctx.weapons ? ctx.weapons() : [];
          if (!all.length) return `<p class="fg-play-note">Aucune arme dans ton sac : tu te bats avec l'épée d'entraînement. Elles tombent quand tu travailles.</p>`;
          const chips = all.map((x) => `<button type="button" class="fg-pw ${x.worn ? "on" : ""}" style="--rc:${S.GRADE[x.rarity]?.c ?? "#9aa0ab"}" data-pw="${esc(x.id)}" title="${esc(x.name)} : ${esc(x.line)}"><img src="${x.icon}" alt="${esc(x.name)}"></button>`).join("");
          return `<div class="fg-pw-row"><button type="button" class="fg-mini" data-pw-step="-1" aria-label="Arme précédente">‹</button><div class="fg-pw-list">${chips}</div><button type="button" class="fg-mini" data-pw-step="1" aria-label="Arme suivante">›</button></div>`;
        }
        function showIntro() {
          phase = "intro";
          const bonusLine = Object.keys(built.slots).length ? `Équipement : ${Object.entries(built.slots).map(([slot, s]) => `${C.SLOT_NAME[slot].toLowerCase()} ${lineText(s)}`).join(" · ")}.` : "Aucun équipement porté : équipe ton sac pour gagner des caractéristiques.";
          const r = w.roll, jet = w.training || r.standard ? "" : ` · ${esc(r.label)} (${Math.round(r.quality * 100)} %)`;
          msgEl.hidden = false;
          msgEl.innerHTML = `<h3>Vagues sans fin</h3>
            <p class="fg-play-note">Un boss toutes les 5 vagues : le Seigneur, le Colosse, l'Archimage, puis on recommence, plus fort. Tu combats jusqu'à tomber ; Échap bat en retraite et garde tes vagues.</p>
            ${weaponPicker()}
            <p>Arme : <b>${esc(w.spec.name)}</b>${w.training ? " d'entraînement" : ` ${esc(S.GRADE[w.rarity]?.name.toLowerCase() ?? "")}`}${jet}</p>
            <p class="fg-play-note">${esc(w.spec.perk)}</p>
            ${(r.affixes || []).map((a) => `<p class="fg-play-note fg-play-aff">◆ ${esc(a.text)}</p>`).join("")}
            <p>${d.maxHp} PV · ${d.damage} dégâts · ${round2(1 / d.cooldown)} coups/s · vitesse ${d.speed} · critique ${pct(d.crit)} · roulade ${d.dashCd} s</p>
            <p>${esc(bonusLine)}</p>
            ${options.best ? `<p>Ton record : ${options.best.wave} vague${options.best.wave > 1 ? "s" : ""} terminée${options.best.wave > 1 ? "s" : ""}${options.best.wins ? `, ${options.best.wins} victoire${options.best.wins > 1 ? "s" : ""}` : ""}.</p>` : ""}
            <p class="fg-play-key">Flèches gauche et droite : changer d'arme · Entrée : combattre</p>`;
          msgEl.querySelector(".fg-pw.on")?.scrollIntoView({ block: "nearest", inline: "center" });
        }
        /** Équipe l'arme voisine (`step`) ou l'arme `id`, puis recalcule le forgeron et réaffiche l'introduction. */
        function equipWeapon(step, id) {
          const all = ctx.weapons ? ctx.weapons() : [];
          if (!all.length || !ctx.equipWeapon) return;
          const i = Math.max(0, all.findIndex((x) => x.worn)), target = id ?? all[(i + step + all.length) % all.length].id;
          const res = ctx.equipWeapon(target);
          if (!res) return;
          built = res.built; d = built.derived; w = built.weapon; equipment = res.equipment; look = ctx.look();
          ctx.sfx.select?.();
          showIntro();
        }
        function restart() {
          fight = C.create({ level: built.level, stats: built.base, equipment, endless: true, seed: (Date.now() ^ (runs++ * 2654435761)) >>> 0 });
          msgEl.hidden = true; phase = "fight"; acc = 0; banner = ""; endAt = 0;
        }
        function showEnd() {
          phase = "end";
          const r = fight.result(), given = ctx.onFightEnd(r) ?? { gold: 0, note: "" };
          lastResult = { ...r, gold: given.gold };
          msgEl.hidden = false;
          msgEl.innerHTML = `<h3 class="${r.state}">${r.endless ? "Tu es tombé" : r.state === "won" ? "Victoire !" : "Défaite"}</h3>
            <p>${esc(fight.ending)}</p>
            <p>${r.cleared} vague${r.cleared > 1 ? "s" : ""} terminée${r.cleared > 1 ? "s" : ""}${r.endless ? "" : ` sur ${C.WAVES.length}`} · ${r.kills} bot${r.kills > 1 ? "s" : ""} vaincu${r.kills > 1 ? "s" : ""} · ${Math.round(r.time)} s</p>
            <p>Or gagné : <b>${given.gold}</b>${given.note ? ` <small>${esc(given.note)}</small>` : ""}</p>
            <p class="fg-play-key"><button type="button" class="fg-btn" data-play-again>Rejouer (R)</button> <button type="button" class="fg-btn ghost" data-play-arms>Changer d'arme (A)</button> <button type="button" class="fg-btn ghost" data-play-quit>Quitter (Échap)</button></p>`;
        }
        function quit() {
          // Battre en retraite en plein combat : les vagues déjà terminées comptent (or et record)
          if (phase === "fight" && fight && fight.state !== "won" && fight.state !== "lost" && fight.cleared > 0) {
            const r = { ...fight.result(), state: "retreat" }, given = ctx.onFightEnd(r) ?? { gold: 0 };
            lastResult = { ...r, gold: given.gold };
          }
          current = null;
          cancelAnimationFrame(raf);
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("keyup", onKeyUp, true);
          window.removeEventListener("blur", onBlur);
          root.remove();
          ctx.onKeysCaptured(false);
          resolve(lastResult ? { ...lastResult } : { state: "quit", cleared: 0, wave: 0, kills: 0, time: 0, gold: 0 });
        }
        function onKey(ev) {
          if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
          const key = ev.key.toLowerCase();
          ev.stopImmediatePropagation();
          if (key === "escape") { ev.preventDefault(); return quit(); }
          if (phase === "intro" && (key === "enter" || key === " ")) { ev.preventDefault(); restart(); return; }
          if (phase === "intro" && (key === "arrowleft" || key === "q")) { ev.preventDefault(); equipWeapon(-1); return; }
          if (phase === "intro" && (key === "arrowright" || key === "d")) { ev.preventDefault(); equipWeapon(1); return; }
          if (phase === "end" && key === "r") { ev.preventDefault(); restart(); return; }
          if (phase === "end" && key === "a") { ev.preventDefault(); fight = null; showIntro(); return; }
          if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"].includes(key)) ev.preventDefault();
          keys.add(key);
        }
        const onKeyUp = (ev) => { ev.stopImmediatePropagation(); keys.delete(ev.key.toLowerCase()); };
        const onBlur = () => keys.clear();
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", onBlur);
        root.addEventListener("click", (ev) => {
          const chip = ev.target.closest("[data-pw]"), step = ev.target.closest("[data-pw-step]");
          if (ev.target.closest("[data-play-quit]")) quit();
          else if (chip) equipWeapon(0, chip.dataset.pw);
          else if (step) equipWeapon(Number(step.dataset.pwStep));
          else if (ev.target.closest("[data-play-again]")) restart();
          else if (ev.target.closest("[data-play-arms]")) { fight = null; showIntro(); }
          else if (phase === "intro" && ev.target.closest(".fg-play-msg") && !ev.target.closest(".fg-pw-row")) restart();
        });

        const input = () => {
          const k = (...names) => names.some((n) => keys.has(n));
          return { left: k("arrowleft", "q", "a"), right: k("arrowright", "d"), up: k("arrowup", "z", "w"), down: k("arrowdown", "s"), attack: k(" ", "e", "enter"), dash: k("shift", "c") };
        };

        function draw() {
          c.setTransform(2, 0, 0, 2, 0, 0);
          c.drawImage(bg, 0, 0, W * T, H * T);
          drawCrowd(c, t);
          const items = C.OBSTACLES.map((o) => ({ y: o.y + o.h, draw: () => drawPillar(c, o) }));
          if (fight) {
            for (const b of fight.bots) items.push({ y: b.y + b.r, draw: () => drawBot(c, b, t) });
            items.push({ y: fight.hero.y + fight.hero.r, draw: () => drawHero(c, fight, look, t) });
          }
          items.sort((a, b) => a.y - b.y).forEach((i) => i.draw());
          S.lightPass(c, t, W, H);
          if (!fight) return;
          // Annonce de la charge du seigneur : une bande rouge sur sa trajectoire
          for (const b of fight.bots) if (b.alive && b.windup > 0 && b.tell?.kind === "charge") { c.globalAlpha = 0.25 + 0.2 * Math.sin(t * 30); const [ux, uy] = b.tell.dir; for (let i = 14; i < 190; i += 6) px(c, b.x + ux * i - 4, b.y + uy * i - 4, 8, 8, "#ff3a2a"); c.globalAlpha = 1; }
          for (const f of fight.fx) if (f.kind === "slash") drawSlash(c, f);
          for (const s of fight.shots) drawShot(c, s);
          for (const f of fight.fx) {
            if (f.kind === "puff") { const k = f.t / f.life; c.globalAlpha = 1 - k; for (let i = 0; i < 6; i++) { const a = i * 1.05; px(c, f.x + Math.cos(a) * (3 + k * 10), f.y + Math.sin(a) * (3 + k * 10) - k * 4, 3, 3, "#f5e9c8"); } c.globalAlpha = 1; }
            else if (f.kind === "shock") { const k = f.t / f.life, rr = f.r * (0.4 + 0.6 * k); c.globalAlpha = 0.85 * (1 - k); for (let i = 0; i < 18; i++) { const a = (i / 18) * Math.PI * 2; px(c, Math.round(f.x + Math.cos(a) * rr) - 1, Math.round(f.y + Math.sin(a) * rr * 0.8) - 1, 3, 3, i % 2 ? "#f5e9c8" : "#c9a36a"); } c.globalAlpha = 1; }
            else if (f.kind === "num") { const k = f.t / f.life; c.globalAlpha = 1 - k * k; c.font = f.crit ? "bold 10px monospace" : "bold 8px monospace"; c.textAlign = "center"; c.fillStyle = "#1d1814"; c.fillText(f.text, f.x + 1, f.y - k * 14 + 1); c.fillStyle = f.hero ? "#ff6a5a" : f.heal ? "#7be092" : f.burn ? "#ff9a3a" : f.bolt ? "#9ad7ff" : f.crit ? "#ffd37a" : "#ffffff"; c.fillText(f.text, f.x, f.y - k * 14); c.globalAlpha = 1; }
            else if (f.kind === "bolt") {
              // Éclair de l'arme : un trait brisé du bot touché à son voisin, qui s'efface vite
              const k = f.t / f.life, n = 5;
              c.globalAlpha = 1 - k; c.lineWidth = 2; c.strokeStyle = "#bfe4ff"; c.beginPath(); c.moveTo(f.x, f.y);
              for (let i = 1; i <= n; i++) { const u = i / n, jx = i < n ? ((i * 7919) % 5 - 2) * 1.6 : 0, jy = i < n ? ((i * 104729) % 5 - 2) * 1.6 : 0; c.lineTo(f.x + (f.x2 - f.x) * u + jx, f.y + (f.y2 - f.y) * u + jy); }
              c.stroke(); c.lineWidth = 1; c.strokeStyle = "#ffffff"; c.stroke(); c.globalAlpha = 1;
            }
          }
          // Jauges : points de vie et roulade, en haut à gauche, sur la palissade
          const h = fight.hero, frac = Math.max(0, h.hp / h.maxHp);
          px(c, 6, 4, 104, 12, "#1d1814"); px(c, 8, 6, 100, 8, "#4a1a1a"); px(c, 8, 6, Math.round(100 * frac), 8, frac > 0.35 ? "#4cc46a" : "#e0453a"); px(c, 8, 6, Math.round(100 * frac), 2, "rgba(255,255,255,.35)");
          c.font = "bold 7px monospace"; c.textAlign = "left"; c.fillStyle = "#fff"; c.fillText(`${h.hp}/${h.maxHp}`, 12, 13);
          const hud = fight.hud();
          px(c, 6, 18, 56, 5, "#1d1814"); px(c, 7, 19, Math.round(54 * hud.dashPct), 3, hud.dashReady ? "#7ad0ff" : "#4a6a88");
          // Vague annoncée au centre, quelques secondes
          if (bannerT > 0) { c.globalAlpha = Math.min(1, bannerT); c.font = "bold 14px monospace"; c.textAlign = "center"; c.fillStyle = "#1d1814"; c.fillText(banner, 193, 97); c.fillStyle = "#ffd37a"; c.fillText(banner, 192, 96); c.globalAlpha = 1; }
          // Barre du seigneur
          const boss = fight.bots.find((b) => b.alive && b.spec.boss);
          if (boss) { px(c, 92, 222, 200, 10, "#1d1814"); px(c, 94, 224, Math.round(196 * Math.max(0, boss.hp / boss.maxHp)), 6, "#e8a05a"); c.font = "bold 7px monospace"; c.textAlign = "center"; c.fillStyle = "#fff"; c.fillText(boss.spec.name, 192, 229); }
        }

        function frame(now) {
          raf = requestAnimationFrame(frame);
          const dt = Math.min(0.1, (now - (last || now)) / 1000);
          last = now;
          t += dt;
          bannerT = Math.max(0, bannerT - dt);
          if (phase === "fight" && fight) {
            acc += dt;
            while (acc >= C.STEP && fight.state !== "won" && fight.state !== "lost") {
              fight.step(input(), C.STEP);
              acc -= C.STEP;
              for (const e of fight.drain()) {
                if (SFX[e]) ctx.sfx[SFX[e]]?.();
                if (e === "wave") { const info = C.waveFor(fight.wave); banner = info.boss ? `Vague ${fight.wave} · BOSS : ${info.name}` : `Vague ${fight.wave} · ${info.name}`; bannerT = 2.2; }
                if (e === "clear") { banner = "Vague terminée"; bannerT = 1.5; }
              }
            }
            const h = fight.hud();
            hudEl.innerHTML = `<span>Vague ${Math.max(1, h.wave)}${h.waves ? `/${h.waves}` : ""}${h.boss ? " (boss)" : ""}</span><span>Ennemis ${h.botsLeft}</span><span>Vaincus ${h.kills}</span>`;
            if (h.state === "won" || h.state === "lost") { if (!endAt) endAt = now + 900; if (now >= endAt) { endAt = 0; showEnd(); } }
          }
          draw();
        }
        showIntro();
        raf = requestAnimationFrame(frame);
      });
    }
    return { start, close: () => current?.() };
  }

  window.ForgeArena = { create, BOT_LOOKS };
})();
