/* Sons de la forge : tout est synthétisé par le navigateur (Web Audio), aucun fichier. Le son démarre au premier geste (règle des navigateurs). */
(() => {
  "use strict";
  const KEY = "ra.game.audio";
  const defaults = { sfx: false, music: false, volume: 0.6 };
  let prefs = { ...defaults };
  try { prefs = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* stockage indisponible */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* stockage indisponible */ } };

  let ctx = null, master = null, sfxBus = null, musicBus = null, noiseBuf = null;
  let fire = null, musicTimer = null, musicStep = 0, nextTime = 0;

  /** Crée le contexte audio. À appeler depuis un geste de l'utilisateur ; sans effet s'il existe déjà. */
  function unlock() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume().catch(() => undefined); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch { return false; }
    master = ctx.createGain();
    master.gain.value = 0.55 * prefs.volume;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = prefs.sfx ? 1 : 0; sfxBus.connect(master);
    musicBus = ctx.createGain(); musicBus.gain.value = prefs.music ? 0.5 : 0; musicBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }
  const ready = () => ctx !== null && ctx.state === "running";

  /** Une note : oscillateur, enveloppe courte, glissando facultatif. */
  function tone({ f, f2, type = "square", dur = 0.1, vol = 0.1, at = 0, attack = 0.005, bus = sfxBus, detune = 0 }) {
    if (!ready()) return;
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0); o.detune.value = detune;
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(bus);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  /** Un souffle de bruit filtré (pas, étincelles, crépitement). */
  function noise({ dur = 0.06, vol = 0.1, hp = 0, lp = 0, at = 0, bus = sfxBus }) {
    if (!ready()) return;
    const t0 = ctx.currentTime + at;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = noiseBuf;
    let node = s;
    if (hp) { const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp; node.connect(f); node = f; }
    if (lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp; node.connect(f); node = f; }
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    node.connect(g); g.connect(bus);
    s.start(t0, Math.random() * 0.5, dur + 0.02);
  }

  const sfx = {
    step() { noise({ dur: 0.05, vol: 0.12, hp: 120, lp: 600 + Math.random() * 300 }); },
    bump() { tone({ f: 95, f2: 55, type: "sine", dur: 0.09, vol: 0.22 }); },
    /** Coup de marteau sur l'enclume ; `gain` de 0 à 1 selon la distance. */
    hammer(gain = 1) {
      noise({ dur: 0.06, vol: 0.3 * gain, hp: 2500 });
      tone({ f: 1250 + Math.random() * 60, type: "triangle", dur: 0.25, vol: 0.2 * gain });
      tone({ f: 1870, type: "triangle", dur: 0.18, vol: 0.12 * gain });
      tone({ f: 130, f2: 50, type: "sine", dur: 0.1, vol: 0.22 * gain });
    },
    blip(pitch = 0) { tone({ f: 380 + pitch * 55, type: "square", dur: 0.035, vol: 0.05 }); },
    select() { tone({ f: 660, dur: 0.05, vol: 0.07 }); tone({ f: 880, dur: 0.07, vol: 0.07, at: 0.05 }); },
    open() { tone({ f: 520, type: "triangle", dur: 0.09, vol: 0.12 }); tone({ f: 780, type: "triangle", dur: 0.14, vol: 0.12, at: 0.08 }); },
    close() { tone({ f: 700, type: "triangle", dur: 0.08, vol: 0.1 }); tone({ f: 470, type: "triangle", dur: 0.12, vol: 0.1, at: 0.07 }); },
    coin() { tone({ f: 988, dur: 0.07, vol: 0.1 }); tone({ f: 1319, dur: 0.22, vol: 0.1, at: 0.07 }); },
    error() { tone({ f: 210, f2: 120, type: "sawtooth", dur: 0.22, vol: 0.09 }); },
    spawn() { tone({ f: 660, f2: 1760, type: "sine", dur: 0.45, vol: 0.12, attack: 0.04 }); tone({ f: 1320, f2: 2640, type: "triangle", dur: 0.4, vol: 0.05, at: 0.05 }); },
    fanfare() {
      [523, 659, 784, 1047].forEach((f, i) => tone({ f, dur: i === 3 ? 0.42 : 0.1, vol: 0.11, at: i * 0.1 }));
      tone({ f: 262, type: "triangle", dur: 0.5, vol: 0.12, at: 0.3 });
    },
  };
  for (const name of Object.keys(sfx)) {
    const fn = sfx[name];
    sfx[name] = (...args) => { if (prefs.sfx) fn(...args); };
  }

  /** Crépitement du feu en fond ; `level` de 0 (éteint) à 1 (tout près). */
  function setFire(level) {
    if (!ready()) return;
    if (!fire) {
      const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
      src.buffer = noiseBuf; src.loop = true;
      bp.type = "bandpass"; bp.frequency.value = 650; bp.Q.value = 0.6;
      g.gain.value = 0;
      lfo.frequency.value = 6.5; lg.gain.value = 0.02;
      lfo.connect(lg); lg.connect(g.gain);
      src.connect(bp); bp.connect(g); g.connect(sfxBus);
      src.start(); lfo.start();
      fire = { g, pops: setInterval(() => { if (fire && fire.level > 0.05 && prefs.sfx) noise({ dur: 0.025, vol: 0.05 * fire.level, hp: 3000 }); }, 380), level: 0 };
    }
    fire.level = level;
    fire.g.gain.setTargetAtTime(0.05 * level, ctx.currentTime, 0.25);
  }

  /* --- Musique : une boucle de taverne en la mineur, jouée note par note par un petit ordonnanceur --- */
  const STEP = 60 / 88 / 2;
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const BASS = [[45, 45, 52, 45], [41, 41, 48, 41], [48, 48, 55, 48], [43, 43, 50, 43]]; // un accord par mesure : la, fa, do, sol
  const LEAD = [
    [69, 0, 72, 0, 76, 0, 72, 0],
    [65, 0, 69, 0, 72, 0, 69, 0],
    [72, 0, 76, 0, 79, 0, 76, 0],
    [71, 0, 74, 0, 79, 76, 74, 0],
  ];
  function playStep(step, when) {
    const bar = Math.floor(step / 8) % 4, i = step % 8;
    const at = when - ctx.currentTime;
    if (i % 2 === 0) tone({ f: hz(BASS[bar][i / 2]), type: "triangle", dur: STEP * 1.8, vol: 0.2, at, attack: 0.01, bus: musicBus });
    const n = LEAD[bar][i];
    if (n) tone({ f: hz(n), type: "square", dur: STEP * 1.5, vol: 0.05, at, attack: 0.01, bus: musicBus });
    if (i === 4) noise({ dur: 0.04, vol: 0.03, hp: 5000, at, bus: musicBus });
  }
  function startMusic() {
    if (musicTimer || !ready()) return;
    musicStep = 0; nextTime = ctx.currentTime + 0.1;
    musicTimer = setInterval(() => {
      while (nextTime < ctx.currentTime + 0.45) { playStep(musicStep++, nextTime); nextTime += STEP; }
    }, 120);
  }
  function stopMusic() { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } }

  /** Applique les préférences au contexte audio (volume, son, musique). */
  function apply() {
    if (!ctx) return;
    master.gain.setTargetAtTime(0.55 * prefs.volume, ctx.currentTime, 0.05);
    sfxBus.gain.setTargetAtTime(prefs.sfx ? 1 : 0, ctx.currentTime, 0.05);
    musicBus.gain.setTargetAtTime(prefs.music ? 0.5 : 0, ctx.currentTime, 0.2);
    if (prefs.music) startMusic(); else stopMusic();
  }

  window.ForgeAudio = {
    unlock,
    sfx,
    setFire,
    prefs: () => ({ ...prefs }),
    set(name, value) { prefs[name] = value; save(); apply(); },
    /** Coupe ou rétablit tout (touche M). @returns Vrai si le son est maintenant coupé. */
    toggleAll() {
      const mute = prefs.sfx || prefs.music;
      prefs.sfx = !mute; prefs.music = !mute; save(); apply();
      return mute;
    },
    /** Démarre la musique si elle est voulue (après le premier geste). */
    start() { if (unlock()) apply(); },
    /** Arrête tout (on quitte la forge, ou la page est cachée). */
    stop() {
      stopMusic();
      if (fire) { fire.g.gain.setTargetAtTime(0, ctx.currentTime, 0.1); fire.level = 0; }
      if (ctx && ctx.state === "running") ctx.suspend().catch(() => undefined);
    },
    /** Reprend après un arrêt (retour dans la forge). */
    resume() { if (ctx) { ctx.resume().then(() => apply()).catch(() => undefined); } },
  };
})();
