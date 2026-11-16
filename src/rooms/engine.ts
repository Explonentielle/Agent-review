import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PROJECT_ROOT } from "../paths.js";

/** Touches lues à chaque image. */
export interface EngineInput {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
  jump?: boolean;
  act?: boolean;
}

export interface EngineThing {
  id: string;
  kind: string;
  group: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alive: boolean;
}

export interface EngineHud {
  score: number;
  lives: number;
  keys: number;
  state: "playing" | "won" | "lost";
  ending: string;
  time: number;
  remaining: number | null;
  message: string | null;
}

/** Une partie en cours (voir `public/forge/engine.js`). */
export interface EngineGame {
  state: "playing" | "won" | "lost";
  ending: string;
  score: number;
  lives: number;
  keys: number;
  t: number;
  flags: Record<string, boolean>;
  player: { x: number; y: number; w: number; h: number; vx: number; vy: number; onGround: boolean; inv: number };
  things: EngineThing[];
  events: string[];
  tick(dt: number, input: EngineInput): void;
  step(dt: number, input: EngineInput): void;
  hud(): EngineHud;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface Engine {
  T: number;
  W: number;
  H: number;
  STEP: number;
  TILES: Record<string, string>;
  MODES: string[];
  KINDS: Record<string, { w: number; h: number; group: string; value?: number; flying?: boolean }>;
  PATTERNS: string[];
  EVENTS: string[];
  EFFECTS: string[];
  WIN_CONDITIONS: string[];
  LIMITS: { things: number; spawned: number; rules: number; effects: number; text: number; title: number; intro: number; lives: number; patrolRange: number; score: number };
  PHYSICS: Record<"gravity" | "speed" | "jump", [number, number]>;
  create(def: unknown): EngineGame;
  smoke(def: unknown): string[];
  solve(def: unknown, opts?: { maxNodes?: number; maxMs?: number }): { solved: boolean; seconds: number; nodes: number };
}

let cached: Engine | null = null;

/**
 * Charge le moteur de jeu du navigateur (`public/forge/engine.js`) pour le serveur : c'est le MÊME fichier, donc ce que le serveur contrôle est
 * exactement ce que le joueur jouera. Il s'exécute dans un contexte isolé, sans accès au reste du processus.
 * @returns Le moteur (chargé une seule fois).
 */
export function loadEngine(): Engine {
  if (cached) return cached;
  const code = readFileSync(path.join(PROJECT_ROOT, "public", "forge", "engine.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(code, context, { filename: "engine.js", timeout: 1000 });
  const engine = (context as { ForgeEngine?: Engine }).ForgeEngine;
  if (!engine) throw new Error("Le moteur de jeu ne s'est pas chargé");
  cached = engine;
  return engine;
}
