import type { Role } from "../db/accounts.js";

/**
 * Droits par rôle. Chaque route de l'API demande un niveau :
 * - `read` : lire (tickets, tâches, reviews, réglages) : tous les rôles, lecteur compris ;
 * - `act` : agir pour son compte (lancer l'agent, relire, fusionner, créer un ticket, gérer SES jetons) : membre et administrateur ;
 * - `admin` : régler l'espace (réglages, projets, équipe, quotas, journal) : administrateur seulement.
 * Le contrôle se fait dans un seul crochet du serveur (`app.ts`), à partir de cette table : une route qui n'y figure pas est REFUSÉE à tout le monde,
 * et un test de `src/auth/permissions.test.ts` échoue tant qu'une route du serveur n'y est pas classée.
 */
export type Level = "read" | "act" | "admin";

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2 };
const NEED: Record<Level, number> = { read: 0, act: 1, admin: 2 };

const LABEL: Record<Role, string> = { viewer: "lecteur", member: "membre", admin: "administrateur" };

/** Niveau demandé par chaque route de l'API, sous la forme `MÉTHODE /chemin/:paramètre`. */
export const ROUTE_LEVELS: Readonly<Record<string, Level>> = {
  // Lecture : tous les rôles
  "GET /api/me": "read",
  "GET /api/stats": "read",
  "GET /api/costs": "read",
  "GET /api/agent-runtime": "read",
  "GET /api/settings": "read",
  "GET /api/projects": "read",
  "GET /api/gitlab/projects": "read",
  "GET /api/gitlab/projects/:id/branches": "read",
  "GET /api/issues": "read",
  "GET /api/tasks": "read",
  "GET /api/tasks/:id": "read",
  "GET /api/tasks/:id/events": "read",
  "GET /api/tasks/:id/piece": "read",
  "GET /api/tasks/:id/attachments": "read",
  "GET /api/pieces": "read",
  "GET /api/reviews": "read",
  "GET /api/reviews/:id": "read",
  "GET /api/forge/namespaces": "read",
  "GET /api/forge/tickets": "read",
  "GET /api/game": "read",
  "GET /api/hero": "read",
  "GET /api/forge/armory": "read",
  "GET /api/forge/loot": "read",
  "GET /api/rooms": "read",
  // Changer d'espace est permis à tout rôle : c'est la session qui change, pas des données (le rôle dans l'espace visé s'applique ensuite)
  "GET /api/workspaces": "read",
  "POST /api/workspaces/active": "read",
  // Créer SA propre organisation est permis à tout rôle : elle n'agit sur aucune donnée de l'espace courant (la personne en devient l'administratrice)
  "POST /api/workspaces": "read",

  // Agir : membre et administrateur
  "GET /api/secrets": "act",
  "GET /api/claude/status": "act",
  "POST /api/claude/check": "act",
  "GET /api/terminal": "act",
  "GET /api/terminal/stream": "act",
  "POST /api/terminal/start": "act",
  "POST /api/terminal/input": "act",
  "POST /api/terminal/stop": "act",
  "POST /api/secrets/:name": "act",
  "POST /api/secrets/:name/delete": "act",
  "POST /api/tasks": "act",
  "POST /api/tasks/:id/followup": "act",
  "POST /api/tasks/:id/fix-review": "act",
  "POST /api/tasks/:id/cancel": "act",
  "POST /api/tasks/:id/cleanup": "act",
  "POST /api/tasks/:id/delete": "act",
  "POST /api/tasks/:id/review": "act",
  "POST /api/tasks/:id/merge": "act",
  "POST /api/reviews/:id/publish": "act",
  "POST /api/reviews/:id/approve": "act",
  "POST /api/reviews/:id/dismiss": "act",
  "POST /api/reviews/:id/start": "act",
  "POST /api/reviews/:id/retry": "act",
  "POST /api/reviews/:id/feedback": "act",
  "POST /api/scribe/draft": "act",
  "POST /api/scribe/tickets": "act",
  "POST /api/scribe/projects": "act",
  "POST /api/attachments": "act",
  "POST /api/attachments/:id/discard": "act",
  "POST /api/forge/weapon-type": "act",

  // Régler l'espace : administrateur seulement
  "GET /api/audit": "admin",
  "GET /api/team": "admin",
  "POST /api/team/invitations": "admin",
  "POST /api/team/invitations/:id/revoke": "admin",
  "POST /api/team/members/:userId/role": "admin",
  "POST /api/team/members/:userId/remove": "admin",
  "POST /api/team/members/:userId/quota": "admin",
  "POST /api/team/convert": "admin",
  "POST /api/team/rename": "admin",
  "POST /api/settings": "admin",
  "POST /api/projects": "admin",
  "POST /api/projects/:id/delete": "admin",
  "POST /api/agent-runtime/check": "admin",
  "POST /api/game": "admin",
};

/**
 * Niveau demandé par une route.
 * @param method Méthode HTTP (HEAD compte comme GET).
 * @param pattern Chemin de la route avec ses paramètres, tel que déclaré (`/api/tasks/:id`).
 * @returns Le niveau, ou undefined si la route n'est pas classée.
 */
export function levelOf(method: string, pattern: string): Level | undefined {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return ROUTE_LEVELS[`${verb} ${pattern}`];
}

/**
 * Un rôle a-t-il le droit d'accéder à un niveau ?
 * @param role Rôle de la personne dans l'espace.
 * @param level Niveau demandé par la route.
 * @returns Vrai si le rôle suffit.
 */
export function allows(role: Role, level: Level): boolean {
  return RANK[role] >= NEED[level];
}

/**
 * Message de refus pour une personne dont le rôle ne suffit pas.
 * @param role Rôle de la personne.
 * @param level Niveau demandé.
 * @returns Le message, destiné à l'utilisateur.
 */
export function refusalMessage(role: Role, level: Level): string {
  const who = level === "admin" ? "un administrateur de l'espace" : "un membre de l'espace";
  return `Ton rôle (${LABEL[role]}) ne permet pas cette action : elle demande ${who}. Demande à un administrateur de changer ton rôle.`;
}
