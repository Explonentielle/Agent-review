/* Jouer à un jeu de salle : le calque plein écran, les touches, le rendu en pixel art et les écrans d'intro et de fin.
   La logique du jeu est dans engine.js (aucun code d'utilisateur ne s'exécute : le moteur lit des données). */
(() => {
  "use strict";
  const S = window.ForgeSprites, A = window.ForgeAudio, ENG = window.ForgeEngine;
  const T = ENG.T, W = ENG.W, H = ENG.H;
  const px = (c, x, y, w, h, col) => S.px(c, Math.round(x), Math.round(y), w, h, col);

  /** Couleurs par thème de salle. */
  const THEMES = {
    forge: { bg: "#1d1814", block: "#6b5a4a", hi: "#8a745e", lo: "#3f3328", mortar: "#2a221b" },
    castle: { bg: "#161a24", block: "#5d6a85", hi: "#7d8aa6", lo: "#363f55", mortar: "#232a3b" },
    tavern: { bg: "#1c1410", block: "#8a5a35", hi: "#a8743f", lo: "#4f3320", mortar: "#2f1f14" },
  };

  /* ---------- dessin de la carte ---------- */
  function drawTile(c, ch, x, y, th) {
    if (ch === "#") {
      px(c, x, y, T, T, th.block);
      px(c, x, y, T, 2, th.hi); px(c, x, y + T - 2, T, 2, th.lo);
      px(c, x + 7, y + 2, 1, 6, th.mortar); px(c, x, y + 7, T, 1, th.mortar); px(c, x + 3, y + 8, 1, 6, th.mortar);
    } else if (ch === "=") {
      px(c, x, y, T, 5, th.hi); px(c, x, y + 5, T, 1, th.lo);
      px(c, x + 3, y + 1, 1, 3, th.mortar); px(c, x + 11, y + 1, 1, 3, th.mortar);
    } else if (ch === "^") {
      for (const dx of [0, 5, 10]) { px(c, x + dx + 2, y + 6, 2, 10, "#b9bfca"); px(c, x + dx + 1, y + 10, 4, 6, "#b9bfca"); px(c, x + dx, y + 13, 6, 3, "#7d838f"); px(c, x + dx + 2, y + 6, 1, 4, "#e8ecf2"); }
    }
  }

  /* ---------- dessin des objets (16 px par case ; `t` en secondes pour les animations) ---------- */
  const DRAW = {
    coin(c, t) {
      const w = [8, 6, 3, 6][Math.floor(t * 6) % 4];
      px(c, 4 + (8 - w) / 2, 3, w, 10, "#ffcf3a"); px(c, 4 + (8 - w) / 2, 3, Math.max(1, w - 3), 2, "#fff2a8"); px(c, 4 + (8 - w) / 2 + w - 1, 5, 1, 7, "#c58a12");
    },
    gem(c, t) {
      px(c, 5, 3, 6, 2, "#9be8ff"); px(c, 3, 5, 10, 3, "#46c8f0"); px(c, 5, 8, 6, 3, "#2a96c8"); px(c, 7, 11, 2, 2, "#1d6a94");
      if (Math.floor(t * 3) % 3 === 0) { px(c, 12, 2, 1, 3, "#fff"); px(c, 11, 3, 3, 1, "#fff"); }
    },
    key(c) { px(c, 3, 4, 5, 5, "#ffcf3a"); px(c, 4, 5, 3, 3, "#1d1814"); px(c, 8, 6, 6, 2, "#ffcf3a"); px(c, 11, 8, 2, 3, "#ffcf3a"); px(c, 13, 8, 1, 2, "#c58a12"); },
    heart(c, t) {
      const b = Math.floor(t * 4) % 2;
      px(c, 3, 4 + b, 4, 3, "#e0453a"); px(c, 9, 4 + b, 4, 3, "#e0453a"); px(c, 3, 6 + b, 10, 3, "#e0453a"); px(c, 5, 9 + b, 6, 2, "#e0453a"); px(c, 7, 11 + b, 2, 1, "#e0453a"); px(c, 4, 5 + b, 2, 1, "#ff8a7e");
    },
    goal(c, t) {
      px(c, 3, 0, 2, 16, "#d8d0b8"); px(c, 3, 0, 2, 1, "#fff");
      const w = Math.floor(Math.sin(t * 5) * 1.2);
      px(c, 5, 1, 9 + w, 3, "#3a9a5a"); px(c, 5, 4, 8 - w, 3, "#2f7a48"); px(c, 5, 7, 5, 1, "#2f7a48");
    },
    door(c) {
      px(c, 0, 0, 16, 16, "#7a4a24"); px(c, 0, 0, 16, 2, "#a8743f"); px(c, 2, 2, 12, 12, "#8a5a30"); px(c, 7, 2, 2, 12, "#6a3e1c");
      px(c, 10, 8, 3, 3, "#ffcf3a"); px(c, 11, 9, 1, 1, "#1d1814");
    },
    spring(c, t) {
      const squish = Math.floor(t * 8) % 4 === 0 ? 1 : 0;
      px(c, 1, 8 + squish, 14, 2, "#c0392b"); px(c, 3, 6 + squish, 10, 2, "#e8685a"); px(c, 2, 11, 12, 3, "#7d838f"); px(c, 2, 11, 12, 1, "#b9bfca");
    },
    slime(c, t) {
      const sq = Math.floor(t * 4) % 2;
      px(c, 2, 8 + sq, 12, 6 - sq, "#4cc46a"); px(c, 3, 6 + sq, 10, 2, "#4cc46a"); px(c, 5, 5 + sq, 6, 1, "#7be092");
      px(c, 5, 8 + sq, 2, 2, "#fff"); px(c, 9, 8 + sq, 2, 2, "#fff"); px(c, 6, 9 + sq, 1, 1, "#1d1814"); px(c, 10, 9 + sq, 1, 1, "#1d1814"); px(c, 2, 13, 12, 1, "#2f8a48");
    },
    bat(c, t) {
      const up = Math.floor(t * 7) % 2;
      px(c, 6, 6, 4, 5, "#5a3a7a"); px(c, 5, 4, 2, 3, "#5a3a7a"); px(c, 9, 4, 2, 3, "#5a3a7a"); px(c, 6, 8, 1, 1, "#ff5a5a"); px(c, 9, 8, 1, 1, "#ff5a5a");
      px(c, 0, up ? 3 : 7, 6, 3, "#3d2658"); px(c, 10, up ? 3 : 7, 6, 3, "#3d2658"); px(c, 2, up ? 5 : 9, 4, 2, "#3d2658"); px(c, 10, up ? 5 : 9, 4, 2, "#3d2658");
    },
    skull(c, t) {
      const b = Math.floor(t * 3) % 2;
      px(c, 3, 3 + b, 10, 8, "#e8e4da"); px(c, 4, 11 + b, 8, 3, "#d0cbbd"); px(c, 4, 6 + b, 3, 3, "#1d1814"); px(c, 9, 6 + b, 3, 3, "#1d1814"); px(c, 7, 9 + b, 2, 2, "#8a857a");
      px(c, 5, 12 + b, 1, 2, "#1d1814"); px(c, 8, 12 + b, 1, 2, "#1d1814"); px(c, 10, 12 + b, 1, 2, "#1d1814");
    },
  };

  /**
   * @param ctx { stage: élément qui contient le jeu, sfx: sons, look: apparence du joueur, onKeysCaptured(on): le monde ignore ses touches pendant le jeu }
   * @returns { start(def, options) } : lance une partie, résolue quand la personne quitte ({ state, score, best }).
   */
  function create(ctx) {
    function start(def, options = {}) {
      return new Promise((resolve) => {
        const th = THEMES[options.theme] ?? THEMES.tavern;
        const look = ctx.look();
        const root = document.createElement("div");
        root.className = "fg-play";
        root.innerHTML = `<div class="fg-play-card" role="dialog" aria-modal="true" aria-label="${esc(def.title)}">
          <div class="fg-play-top"><b>${esc(def.title)}</b><span class="fg-play-hud"></span><button type="button" class="fg-x" data-play-quit aria-label="Quitter" title="Quitter (Échap)"></button></div>
          <div class="fg-play-view"><canvas width="${W * T}" height="${H * T}"></canvas><div class="fg-play-msg"></div><div class="fg-play-say" hidden></div></div>
          <div class="fg-play-help"></div></div>`;
        ctx.stage.append(root);
        const canvas = root.querySelector("canvas"), c = canvas.getContext("2d");
        c.imageSmoothingEnabled = false;
        const hudEl = root.querySelector(".fg-play-hud"), msgEl = root.querySelector(".fg-play-msg"), sayEl = root.querySelector(".fg-play-say"), helpEl = root.querySelector(".fg-play-help");
        const platformer = def.mode === "platformer";
        helpEl.textContent = platformer
          ? "Flèches ou ZQSD : bouger · Espace ou haut : sauter · Échap : quitter"
          : "Flèches ou ZQSD : bouger · Espace : frapper devant soi · Échap : quitter";

        let game = ENG.create(def), phase = "intro", raf = 0, last = 0, t = 0, endAt = 0;
        const keys = new Set();
        ctx.onKeysCaptured(true);

        const input = () => {
          const k = (...names) => names.some((n) => keys.has(n));
          return { left: k("arrowleft", "q", "a"), right: k("arrowright", "d"), up: k("arrowup", "z", "w"), down: k("arrowdown", "s"), jump: platformer && k(" ", "arrowup", "z", "w"), act: !platformer && k(" ", "e", "enter") };
        };

        function showIntro() {
          phase = "intro";
          msgEl.hidden = false;
          msgEl.innerHTML = `<h3>${esc(def.title)}</h3>${def.intro ? `<p>${esc(def.intro)}</p>` : ""}<p class="fg-play-key">Appuie sur Entrée pour commencer</p>`;
        }
        function showEnd() {
          phase = "end";
          const h = game.hud(), best = Math.max(options.best ?? 0, h.score);
          msgEl.hidden = false;
          msgEl.innerHTML = `<h3 class="${h.state}">${h.state === "won" ? "Gagné !" : "Perdu"}</h3><p>${esc(h.ending)}</p><p>Score : <b>${h.score}</b>${best > (options.best ?? 0) && h.score > 0 ? " · nouveau record !" : best ? ` · record : ${best}` : ""}</p>
            <p class="fg-play-key"><button type="button" class="fg-btn" data-play-again>Rejouer (R)</button> <button type="button" class="fg-btn ghost" data-play-quit>Quitter (Échap)</button></p>`;
        }
        function restart() {
          game = ENG.create(def); t = 0; msgEl.hidden = true; phase = "play"; sayEl.hidden = true;
        }
        function quit() {
          cancelAnimationFrame(raf);
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("keyup", onKeyUp, true);
          root.remove();
          ctx.onKeysCaptured(false);
          const h = game.hud();
          resolve({ state: phase === "end" ? h.state : "quit", score: h.score, best: Math.max(options.best ?? 0, h.score) });
        }

        const SFX = { jump: "select", coin: "coin", gem: "coin", key: "coin", heart: "coin", hurt: "error", stomp: "bump", slash: "blip", spring: "open", door: "open", goal: "select", win: "fanfare", lose: "error" };
        function onKey(ev) {
          if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
          const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase();
          ev.stopImmediatePropagation();
          if (key === "escape") { ev.preventDefault(); return quit(); }
          if (phase === "intro" && (key === "enter" || key === " ")) { ev.preventDefault(); restart(); return; }
          if (phase === "end" && key === "r") { ev.preventDefault(); restart(); return; }
          if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) ev.preventDefault();
          keys.add(key);
        }
        const onKeyUp = (ev) => { ev.stopImmediatePropagation(); keys.delete(ev.key.toLowerCase()); };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("keyup", onKeyUp, true);
        root.addEventListener("click", (ev) => {
          if (ev.target.closest("[data-play-quit]")) quit();
          else if (ev.target.closest("[data-play-again]")) restart();
          else if (phase === "intro" && ev.target.closest(".fg-play-msg")) restart();
        });

        function draw() {
          px(c, 0, 0, W * T, H * T, th.bg);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const ch = def.map[y][x]; if (ch !== ".") drawTile(c, ch, x * T, y * T, th); }
          for (const th2 of game.things) {
            if (!th2.alive) continue;
            const fn = DRAW[th2.kind];
            if (!fn) continue;
            // chaque objet est dessiné dans sa case de 16 px, posé sur son rectangle
            c.save();
            c.translate(Math.round(th2.x + th2.w / 2 - 8), Math.round(th2.y + th2.h - 16));
            fn(c, t);
            c.restore();
          }
          const p = game.player;
          if (!(p.inv > 0 && Math.floor(t * 14) % 2 === 0)) {
            const moving = Math.abs(p.vx) > 5 || (!platformer && Math.abs(p.vy) > 5);
            const dir = platformer ? (p.fx < 0 ? "left" : "right") : (p.fy < 0 ? "up" : p.fy > 0 && !p.fx ? "down" : p.fx < 0 ? "left" : "right");
            S.person(c, Math.round(p.x + p.w / 2 - 8), Math.round(p.y + p.h - 16), { ...look, dir, frame: moving && Math.floor(t * 8) % 2 ? 1 : 0 });
          }
          if (!platformer && p.attack > 0) {
            // le même rectangle que celui du moteur : le corps du joueur et 12 px devant lui
            c.globalAlpha = 0.55;
            px(c, p.x - 2 - (p.fx < 0 ? 12 : 0), p.y - 2 - (p.fy < 0 ? 12 : 0), p.w + 4 + (p.fx ? 12 : 0), p.h + 4 + (p.fy ? 12 : 0), "#fff6c8");
            c.globalAlpha = 1;
          }
        }

        function frame(now) {
          raf = requestAnimationFrame(frame);
          const dt = Math.min(0.05, (now - (last || now)) / 1000);
          last = now;
          if (phase === "play") {
            t += dt;
            game.step(dt, input());
            for (const e of game.events) if (SFX[e]) ctx.sfx[SFX[e]]?.();
            const h = game.hud();
            hudEl.innerHTML = `<span>Vies ${"♥".repeat(Math.max(0, h.lives))}</span><span>Score ${h.score}</span>${game.keys ? `<span>Clés ${game.keys}</span>` : ""}${h.remaining !== null ? `<span>Temps ${Math.ceil(h.remaining)}</span>` : ""}`;
            sayEl.hidden = !h.message;
            if (h.message) sayEl.textContent = h.message;
            if (h.state !== "playing") { if (!endAt) endAt = now + 500; if (now >= endAt) { endAt = 0; showEnd(); } }
          }
          draw();
        }
        showIntro();
        raf = requestAnimationFrame(frame);
      });
    }
    return { start };
  }

  window.ForgeGameplay = { create };
})();
