/* Jouer à l'arène : le calque plein écran, les touches, le dessin en pixel art et les écrans d'intro et de fin.
   La logique du combat est dans combat.js (aucun code d'utilisateur ne s'exécute : ce sont les bots et les règles de la forge). */
(() => {
  "use strict";
  const S = window.ForgeSprites, C = window.ForgeCombat;
  const T = C.T, W = C.W, H = C.H;
  const px = (c, x, y, w, h, col) => S.px(c, Math.round(x), Math.round(y), w, h, col);
  const pct = (v) => `${Math.round(v * 100)} %`;

  /** Apparence des bots (les mêmes pièces de dessin que les personnages de la forge). `scale` : taille entière du dessin. */
  const BOT_LOOKS = {
    gobelin: { skin: "#6aa84f", hair: "#2f5a2a", tunic: "#6b4a2a", apron: "#4a3a2a", hat: "bandana", bald: true },
    soldat: { skin: "#e0b088", hair: "#3a2a1c", tunic: "#8a2a2a", apron: "#9aa0ab", hat: "helmet" },
    brute: { skin: "#c88a60", hair: "#3a2a1c", tunic: "#5a4a3a", apron: "#3a2a1c", hat: "viking", beard: true },
    archer: { skin: "#d9a066", hair: "#8a3b12", tunic: "#2f7a5a", apron: "#6b4423", hat: "feather" },
    mage: { skin: "#e0b088", hair: "#e8e4da", tunic: "#4a3f9a", apron: "#f0d078", hat: "wizard", beard: true },
    seigneur: { skin: "#c88a60", hair: "#3a2a1c", tunic: "#7a1f2e", apron: "#f0d078", hat: "crown", beard: true, scale: 2 },
  };
  const SFX = { swing: "blip", "swing-hit": "hammer", hit: "hammer", crit: "coin", shoot: "blip", "bot-shoot": "blip", hurt: "error", kill: "bump", dash: "step", wave: "spawn", clear: "coin", win: "fanfare", lose: "error", summon: "spawn", charge: "bump" };

  const dirOf = (f) => (Math.abs(f[0]) > Math.abs(f[1]) ? (f[0] < 0 ? "left" : "right") : f[1] < 0 ? "up" : "down");

  /* ---------- décor : un sable, une palissade, la foule en haut ---------- */
  function drawStatic(c) {
    px(c, 0, 0, W * T, H * T, "#2a1d12");
    for (let ty = 2; ty < 14; ty++) for (let tx = 1; tx < 23; tx++) {
      px(c, tx * T, ty * T, T, T, (tx + ty) % 2 ? "#d1ae72" : "#c9a56a");
      const n = (tx * 7 + ty * 13) % 5;
      if (n === 0) px(c, tx * T + 3, ty * T + 5, 1, 1, "#a9854f");
      if (n === 2) px(c, tx * T + 10, ty * T + 11, 2, 1, "#b8945a");
      if (n === 3) px(c, tx * T + 7, ty * T + 2, 1, 1, "#e3c48c");
    }
    // Cercle d'honneur au centre : des points sombres
    for (let a = 0; a < 40; a++) { const r = a / 40 * Math.PI * 2; px(c, 192 + Math.cos(r) * 46, 128 + Math.sin(r) * 38, 2, 2, "#a9854f"); }
    // Palissade : planches de bois sur les quatre côtés
    const plank = (x, y, w, h) => { px(c, x, y, w, h, "#5a3a22"); for (let i = 0; i < Math.max(w, h); i += 8) { if (w > h) { px(c, x + i, y, 1, h, "#3b2616"); px(c, x + i + 1, y, 2, h, "#7a5230"); } else { px(c, x, y + i, w, 1, "#3b2616"); px(c, x, y + i + 1, w, 2, "#7a5230"); } } };
    plank(0, 0, W * T, 2 * T); plank(0, 0, T, H * T); plank(23 * T, 0, T, H * T); plank(0, 14 * T, W * T, T);
    px(c, T, 2 * T - 3, 22 * T, 3, "#2a1d12");
    // Bannières rouges et torches le long du mur du haut
    for (const x of [3, 8, 15, 20]) { px(c, x * T + 3, 0, 10, 20, "#9a2a2a"); px(c, x * T + 3, 0, 10, 2, "#c8aa4a"); px(c, x * T + 6, 6, 4, 4, "#f0d078"); px(c, x * T + 3, 18, 3, 2, "#2a1d12"); px(c, x * T + 10, 18, 3, 2, "#2a1d12"); }
  }
  /** Foule et torches : un peu de vie (les têtes ondulent, les flammes tremblent). */
  function drawCrowd(c, t) {
    const COLORS = ["#d9a066", "#f2c9a0", "#8d5a3b", "#c88a60"], CLOTH = ["#3e6fb0", "#b0503e", "#3e9a6a", "#8a5cb0", "#d8a63a"];
    for (let i = 0; i < 17; i++) {
      const x = 22 + i * 21 + ((i * 5) % 7), bob = Math.round(Math.sin(t * 3 + i * 1.7) * 1.2);
      px(c, x, 20 + bob, 7, 6, CLOTH[i % CLOTH.length]); px(c, x + 1, 15 + bob, 5, 5, COLORS[i % COLORS.length]); px(c, x + 1, 15 + bob, 5, 1, "#2a1d12");
    }
    for (const x of [6, 12, 18]) {
      const f = Math.floor(t * 8 + x) % 2;
      px(c, x * T + 6, 8, 3, 8, "#3b2616"); px(c, x * T + 5, 3 + f, 5, 5, "#ff9a2a"); px(c, x * T + 6, 4 + f, 3, 3, "#ffd37a");
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
        const built = options.built, d = built.derived;
        const root = document.createElement("div");
        root.className = "fg-play";
        root.innerHTML = `<div class="fg-play-card" role="dialog" aria-modal="true" aria-label="L'arène">
          <div class="fg-play-top"><b>L'arène</b><span class="fg-play-hud"></span><button type="button" class="fg-x" data-play-quit aria-label="Quitter" title="Quitter (Échap)"></button></div>
          <div class="fg-play-view"><canvas width="${W * T}" height="${H * T}"></canvas><div class="fg-play-msg"></div></div>
          <div class="fg-play-help">Flèches ou ZQSD : bouger · Espace : frapper · Maj : roulade (tu ne peux pas être touché) · Échap : quitter</div></div>`;
        ctx.stage.append(root);
        const canvas = root.querySelector("canvas"), c = canvas.getContext("2d");
        c.imageSmoothingEnabled = false;
        const hudEl = root.querySelector(".fg-play-hud"), msgEl = root.querySelector(".fg-play-msg");
        const bg = document.createElement("canvas"); bg.width = W * T; bg.height = H * T;
        drawStatic(bg.getContext("2d"));
        const look = ctx.look();
        const keys = new Set();
        let fight = null, phase = "intro", raf = 0, last = 0, t = 0, acc = 0, endAt = 0, lastResult = null, runs = 0, banner = "", bannerT = 0;
        ctx.onKeysCaptured(true);
        current = quit;

        const w = built.weapon;
        const bonusLine = Object.keys(built.slots).length ? `Équipement : ${Object.entries(built.slots).map(([slot, s]) => `${C.SLOT_NAME[slot].toLowerCase()} +${s.points} ${C.STATS.find((x) => x.id === s.stat).name.toLowerCase()}`).join(", ")}.` : "Aucun équipement porté : équipe ton sac pour gagner des caractéristiques.";
        function showIntro() {
          phase = "intro";
          msgEl.hidden = false;
          msgEl.innerHTML = `<h3>${C.WAVES.length} vagues, un seigneur</h3>
            <p>Arme : <b>${esc(w.spec.name)}</b>${w.training ? " d'entraînement" : ""} · ${esc(w.spec.blurb)}</p>
            <p>${d.maxHp} PV · ${d.damage} dégâts · vitesse ${d.speed} · critique ${pct(d.crit)} · roulade ${d.dashCd} s</p>
            <p>${esc(bonusLine)}</p>
            ${options.best ? `<p>Ton record : ${options.best.wave} vague${options.best.wave > 1 ? "s" : ""} terminée${options.best.wave > 1 ? "s" : ""}${options.best.wins ? `, ${options.best.wins} victoire${options.best.wins > 1 ? "s" : ""}` : ""}.</p>` : ""}
            <p class="fg-play-key">Appuie sur Entrée pour combattre</p>`;
        }
        function restart() {
          fight = C.create({ level: built.level, stats: built.base, equipment: options.equipment, seed: (Date.now() ^ (runs++ * 2654435761)) >>> 0 });
          msgEl.hidden = true; phase = "fight"; acc = 0; banner = ""; endAt = 0;
        }
        function showEnd() {
          phase = "end";
          const r = fight.result(), given = ctx.onFightEnd(r) ?? { gold: 0, note: "" };
          lastResult = { ...r, gold: given.gold };
          msgEl.hidden = false;
          msgEl.innerHTML = `<h3 class="${r.state}">${r.state === "won" ? "Victoire !" : "Défaite"}</h3>
            <p>${esc(fight.ending)}</p>
            <p>${r.cleared} vague${r.cleared > 1 ? "s" : ""} sur ${C.WAVES.length} · ${r.kills} bot${r.kills > 1 ? "s" : ""} vaincu${r.kills > 1 ? "s" : ""} · ${Math.round(r.time)} s</p>
            <p>Or gagné : <b>${given.gold}</b>${given.note ? ` <small>${esc(given.note)}</small>` : ""}</p>
            <p class="fg-play-key"><button type="button" class="fg-btn" data-play-again>Rejouer (R)</button> <button type="button" class="fg-btn ghost" data-play-quit>Quitter (Échap)</button></p>`;
        }
        function quit() {
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
          if (phase === "end" && key === "r") { ev.preventDefault(); restart(); return; }
          if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"].includes(key)) ev.preventDefault();
          keys.add(key);
        }
        const onKeyUp = (ev) => { ev.stopImmediatePropagation(); keys.delete(ev.key.toLowerCase()); };
        const onBlur = () => keys.clear();
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", onBlur);
        root.addEventListener("click", (ev) => {
          if (ev.target.closest("[data-play-quit]")) quit();
          else if (ev.target.closest("[data-play-again]")) restart();
          else if (phase === "intro" && ev.target.closest(".fg-play-msg")) restart();
        });

        const input = () => {
          const k = (...names) => names.some((n) => keys.has(n));
          return { left: k("arrowleft", "q", "a"), right: k("arrowright", "d"), up: k("arrowup", "z", "w"), down: k("arrowdown", "s"), attack: k(" ", "e", "enter"), dash: k("shift", "c") };
        };

        function draw() {
          c.drawImage(bg, 0, 0);
          drawCrowd(c, t);
          const items = C.OBSTACLES.map((o) => ({ y: o.y + o.h, draw: () => drawPillar(c, o) }));
          if (fight) {
            for (const b of fight.bots) items.push({ y: b.y + b.r, draw: () => drawBot(c, b, t) });
            items.push({ y: fight.hero.y + fight.hero.r, draw: () => drawHero(c, fight, look, t) });
          }
          items.sort((a, b) => a.y - b.y).forEach((i) => i.draw());
          if (!fight) return;
          // Annonce de la charge du seigneur : une bande rouge sur sa trajectoire
          for (const b of fight.bots) if (b.alive && b.windup > 0 && b.tell?.kind === "charge") { c.globalAlpha = 0.25 + 0.2 * Math.sin(t * 30); const [ux, uy] = b.tell.dir; for (let i = 14; i < 190; i += 6) px(c, b.x + ux * i - 4, b.y + uy * i - 4, 8, 8, "#ff3a2a"); c.globalAlpha = 1; }
          for (const f of fight.fx) if (f.kind === "slash") drawSlash(c, f);
          for (const s of fight.shots) drawShot(c, s);
          for (const f of fight.fx) {
            if (f.kind === "puff") { const k = f.t / f.life; c.globalAlpha = 1 - k; for (let i = 0; i < 6; i++) { const a = i * 1.05; px(c, f.x + Math.cos(a) * (3 + k * 10), f.y + Math.sin(a) * (3 + k * 10) - k * 4, 3, 3, "#f5e9c8"); } c.globalAlpha = 1; }
            else if (f.kind === "num") { const k = f.t / f.life; c.globalAlpha = 1 - k * k; c.font = f.crit ? "bold 10px monospace" : "bold 8px monospace"; c.textAlign = "center"; c.fillStyle = "#1d1814"; c.fillText(f.text, f.x + 1, f.y - k * 14 + 1); c.fillStyle = f.hero ? "#ff6a5a" : f.crit ? "#ffd37a" : "#ffffff"; c.fillText(f.text, f.x, f.y - k * 14); c.globalAlpha = 1; }
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
                if (e === "wave") { banner = fight.wave === C.WAVES.length ? "Le Seigneur des braises" : `Vague ${fight.wave} · ${C.WAVES[fight.wave - 1].name}`; bannerT = 2; }
                if (e === "clear") { banner = "Vague terminée"; bannerT = 1.5; }
              }
            }
            const h = fight.hud();
            hudEl.innerHTML = `<span>Vague ${Math.max(1, h.wave)}/${h.waves}</span><span>Ennemis ${h.botsLeft}</span><span>Vaincus ${h.kills}</span>`;
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
