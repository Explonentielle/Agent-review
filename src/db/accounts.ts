import type { Db } from "./db.js";

/** Rôles d'un membre dans un espace, du plus au moins privilégié (admin : gère l'espace ; member : lance les agents ; viewer : lecture seule). */
export const ROLES = ["admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Espace personnel (un seul membre, son propriétaire) ou espace d'équipe (plusieurs membres). */
export type WorkspaceKind = "personal" | "team";

export interface UserRow {
  id: number;
  name: string;
  email: string | null;
  created_at: string;
}

export interface WorkspaceRow {
  id: number;
  name: string;
  kind: WorkspaceKind;
  created_at: string;
}

/** Espace vu depuis un utilisateur : l'espace et le rôle qu'il y a. */
export interface WorkspaceOfUser extends WorkspaceRow {
  role: Role;
}

export interface MemberRow {
  user_id: number;
  name: string;
  email: string | null;
  role: Role;
  created_at: string;
  /** Budget mensuel propre à ce membre en dollars (null : valeur par défaut de l'espace ; 0 : sans limite). */
  budget_usd: number | null;
  /** Nombre d'agents lancés par jour propre à ce membre (null : valeur par défaut de l'espace ; 0 : sans limite). */
  daily_runs: number | null;
}

/** Compte de forge lié à un utilisateur. */
export interface IdentityRow {
  provider: string;
  login: string;
}

/** Qui agit, dans quel espace et avec quel rôle : ce que chaque requête devra porter (lot C4). */
export interface AccountContext {
  userId: number;
  workspaceId: number;
  role: Role;
}

/** Règle du modèle de comptes violée (dernier admin, espace personnel, doublon...). Le message est destiné à l'utilisateur. */
export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Nettoie un nom d'utilisateur ou d'espace.
 * @param name Nom saisi.
 * @param label Ce que désigne le nom, pour le message d'erreur.
 * @returns Le nom sans espaces autour.
 * @throws AccountError Si le nom est vide ou trop long.
 */
function cleanName(name: string, label: string): string {
  const clean = name.trim();
  if (clean === "" || clean.length > MAX_NAME_LENGTH) throw new AccountError(`${label} : entre 1 et ${MAX_NAME_LENGTH} caractères`);
  return clean;
}

/**
 * Normalise une adresse email (minuscules, sans espaces autour).
 * @param email Adresse saisie, ou null/vide si l'utilisateur n'en a pas.
 * @returns L'adresse normalisée, ou null si aucune.
 * @throws AccountError Si l'adresse n'a pas un format valide.
 */
export function cleanEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined || email.trim() === "") return null;
  const clean = email.trim().toLowerCase();
  if (clean.length > MAX_EMAIL_LENGTH || !EMAIL_FORMAT.test(clean)) throw new AccountError("Adresse email invalide");
  return clean;
}

/**
 * Vérifie qu'une valeur est un rôle connu.
 * @param role Valeur à contrôler.
 * @returns Le rôle, typé.
 * @throws AccountError Si le rôle n'existe pas.
 */
function checkRole(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) throw new AccountError(`Rôle inconnu : ${ROLES.join(", ")}`);
  return role as Role;
}

export type AccountRepo = ReturnType<typeof createAccountRepo>;

/**
 * Utilisateurs, espaces et appartenances. Les règles qui protègent les données (un espace garde un admin,
 * un espace personnel n'a qu'un membre) sont ici ; qui a le droit d'appeler ces opérations se décide plus haut (lot C4).
 */
export function createAccountRepo(db: Db) {
  /**
   * Lit un utilisateur.
   * @param id Identifiant de l'utilisateur.
   * @returns L'utilisateur, ou undefined s'il n'existe pas.
   */
  const getUser = (id: number): Promise<UserRow | undefined> => db.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);

  /**
   * Lit un espace.
   * @param id Identifiant de l'espace.
   * @returns L'espace, ou undefined s'il n'existe pas.
   */
  const getWorkspace = (id: number): Promise<WorkspaceRow | undefined> => db.get<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", [id]);

  /**
   * Rôle d'un utilisateur dans un espace.
   * @param workspaceId Identifiant de l'espace.
   * @param userId Identifiant de l'utilisateur.
   * @returns Le rôle, ou null si l'utilisateur n'est pas membre de cet espace.
   */
  const membershipRole = async (workspaceId: number, userId: number): Promise<Role | null> => {
    const row = await db.get<{ role: Role }>("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?", [workspaceId, userId]);
    return row ? row.role : null;
  };

  /**
   * Lit un espace qui doit exister.
   * @param id Identifiant de l'espace.
   * @returns L'espace.
   * @throws AccountError Si l'espace n'existe pas.
   */
  const requireWorkspace = async (id: number): Promise<WorkspaceRow> => {
    const workspace = await getWorkspace(id);
    if (!workspace) throw new AccountError("Espace introuvable");
    return workspace;
  };

  /**
   * Explique pourquoi une modification d'appartenance n'a rien touché.
   * @param workspaceId Identifiant de l'espace.
   * @param userId Identifiant du membre visé.
   * @returns L'erreur à lever : membre absent, sinon dernier admin.
   */
  const refusalReason = async (workspaceId: number, userId: number): Promise<AccountError> => {
    if ((await membershipRole(workspaceId, userId)) === null) return new AccountError("Cet utilisateur n'est pas membre de l'espace");
    return new AccountError("Cet utilisateur est le dernier administrateur de l'espace : nomme-en un autre avant");
  };

  return {
    getUser,
    getWorkspace,
    membershipRole,

    /**
     * Crée un utilisateur.
     * @param input Nom affiché, et adresse email si on la connaît (unique, insensible à la casse).
     * @returns L'identifiant du nouvel utilisateur.
     * @throws AccountError Si le nom ou l'adresse est invalide, ou si l'adresse est déjà prise.
     */
    async createUser(input: { name: string; email?: string | null }): Promise<number> {
      const name = cleanName(input.name, "Nom");
      const email = cleanEmail(input.email);
      const row = await db.get<{ id: number }>("INSERT INTO users (name, email) VALUES (?, ?) ON CONFLICT (email) DO NOTHING RETURNING id", [name, email]);
      if (!row) throw new AccountError("Cette adresse email est déjà utilisée");
      return row.id;
    },

    /**
     * Donne un nom et une adresse à l'utilisateur local, tant qu'il n'a pas d'adresse (le propriétaire de l'installation reprend ainsi ses données en créant son compte par email).
     * @param userId Identifiant de l'utilisateur local.
     * @param input Nom affiché et adresse email.
     * @returns Vrai si le compte a été repris, faux s'il avait déjà une adresse (repris entre-temps par une autre demande).
     * @throws AccountError Si le nom ou l'adresse est invalide, ou si l'adresse est déjà prise.
     */
    async claimLocalUser(userId: number, input: { name: string; email: string }): Promise<boolean> {
      const name = cleanName(input.name, "Nom");
      const email = cleanEmail(input.email);
      if (email === null) throw new AccountError("Adresse email invalide");
      if (await db.get("SELECT 1 AS found FROM users WHERE email = ?", [email])) throw new AccountError("Cette adresse email est déjà utilisée");
      const res = await db.run("UPDATE users SET name = ?, email = ? WHERE id = ? AND email IS NULL", [name, email, userId]);
      return res.changes === 1;
    },

    /**
     * Retrouve un utilisateur par son adresse email.
     * @param email Adresse recherchée (la casse et les espaces autour sont ignorés).
     * @returns L'utilisateur, ou undefined si aucun n'a cette adresse.
     * @throws AccountError Si l'adresse n'a pas un format valide.
     */
    async getUserByEmail(email: string): Promise<UserRow | undefined> {
      const clean = cleanEmail(email);
      if (clean === null) return undefined;
      return db.get<UserRow>("SELECT * FROM users WHERE email = ?", [clean]);
    },

    /**
     * Crée un espace dont l'utilisateur donné est l'administrateur.
     * @param input Nom de l'espace, son type, et l'utilisateur qui l'administre.
     * @returns L'identifiant du nouvel espace.
     * @throws AccountError Si le nom est invalide, l'utilisateur inconnu, ou s'il a déjà un espace personnel.
     */
    async createWorkspace(input: { name: string; kind: WorkspaceKind; adminUserId: number }): Promise<number> {
      const name = cleanName(input.name, "Nom de l'espace");
      if (input.kind !== "personal" && input.kind !== "team") throw new AccountError("Type d'espace inconnu : personal ou team");
      if (!(await getUser(input.adminUserId))) throw new AccountError("Utilisateur introuvable");
      if (input.kind === "personal") {
        const existing = await db.get(
          "SELECT 1 AS found FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND w.kind = 'personal'",
          [input.adminUserId],
        );
        if (existing) throw new AccountError("Cet utilisateur a déjà un espace personnel");
      }
      const workspace = await db.get<{ id: number }>("INSERT INTO workspaces (name, kind) VALUES (?, ?) RETURNING id", [name, input.kind]);
      try {
        await db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'admin')", [workspace!.id, input.adminUserId]);
      } catch (err) {
        await db.run("DELETE FROM workspaces WHERE id = ?", [workspace!.id]); // pas d'espace sans administrateur
        throw err;
      }
      return workspace!.id;
    },

    /**
     * Renomme un espace.
     * @param workspaceId Identifiant de l'espace.
     * @param name Nouveau nom.
     * @returns Rien.
     * @throws AccountError Si le nom est invalide ou l'espace inconnu.
     */
    async renameWorkspace(workspaceId: number, name: string): Promise<void> {
      const clean = cleanName(name, "Nom de l'espace");
      const res = await db.run("UPDATE workspaces SET name = ? WHERE id = ?", [clean, workspaceId]);
      if (res.changes === 0) throw new AccountError("Espace introuvable");
    },

    /**
     * Espaces dont l'utilisateur est membre, avec son rôle dans chacun.
     * @param userId Identifiant de l'utilisateur.
     * @returns Ses espaces, du plus ancien au plus récent.
     */
    listWorkspacesOf(userId: number): Promise<WorkspaceOfUser[]> {
      return db.all<WorkspaceOfUser>(
        `SELECT w.id AS id, w.name AS name, w.kind AS kind, w.created_at AS created_at, m.role AS role
           FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = ? ORDER BY w.id`,
        [userId],
      );
    },

    /**
     * Membres d'un espace.
     * @param workspaceId Identifiant de l'espace.
     * @returns Les membres avec leur rôle, dans l'ordre de création des comptes.
     */
    listMembers(workspaceId: number): Promise<MemberRow[]> {
      return db.all<MemberRow>(
        `SELECT u.id AS user_id, u.name AS name, u.email AS email, m.role AS role, m.created_at AS created_at, m.budget_usd AS budget_usd, m.daily_runs AS daily_runs
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? ORDER BY u.id`,
        [workspaceId],
      );
    },

    /**
     * Comptes de forge liés à un utilisateur.
     * @param userId Identifiant de l'utilisateur.
     * @returns Ses comptes de forge (forge et identifiant de connexion).
     */
    listIdentities(userId: number): Promise<IdentityRow[]> {
      return db.all<IdentityRow>("SELECT provider, login FROM identities WHERE user_id = ? ORDER BY id", [userId]);
    },

    /**
     * Transforme un espace personnel en espace d'équipe, pour pouvoir y inviter du monde. Les données de l'espace restent en place. Sans retour : une équipe
     * qui a des membres ne redevient pas personnelle.
     * @param workspaceId Identifiant de l'espace.
     * @param name Nouveau nom (facultatif : l'ancien est gardé).
     * @returns Rien.
     * @throws AccountError Si l'espace est introuvable, déjà une équipe, ou si le nom est invalide.
     */
    async convertToTeam(workspaceId: number, name?: string): Promise<void> {
      const workspace = await requireWorkspace(workspaceId);
      if (workspace.kind === "team") throw new AccountError("Cet espace est déjà un espace d'équipe");
      const clean = name === undefined || name.trim() === "" ? workspace.name : cleanName(name, "Nom de l'espace");
      const res = await db.run("UPDATE workspaces SET kind = 'team', name = ? WHERE id = ? AND kind = 'personal'", [clean, workspaceId]);
      if (res.changes === 0) throw new AccountError("Cet espace est déjà un espace d'équipe");
    },

    /**
     * Fixe les limites propres à un membre : son budget mensuel et son nombre d'agents par jour.
     * @param workspaceId Identifiant de l'espace.
     * @param userId Identifiant du membre.
     * @param quota Budget en dollars et agents par jour : null pour reprendre la valeur par défaut de l'espace, 0 pour ne pas limiter.
     * @returns Rien.
     * @throws AccountError Si une valeur est négative ou trop grande, ou si la personne n'est pas membre.
     */
    async setMemberQuota(workspaceId: number, userId: number, quota: { budgetUsd: number | null; dailyRuns: number | null }): Promise<void> {
      const { budgetUsd, dailyRuns } = quota;
      if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 100_000)) throw new AccountError("Le budget va de 0 à 100000 dollars");
      if (dailyRuns !== null && (!Number.isInteger(dailyRuns) || dailyRuns < 0 || dailyRuns > 1000)) throw new AccountError("Le nombre d'agents par jour va de 0 à 1000");
      const res = await db.run("UPDATE memberships SET budget_usd = ?, daily_runs = ? WHERE workspace_id = ? AND user_id = ?", [budgetUsd, dailyRuns, workspaceId, userId]);
      if (res.changes === 0) throw new AccountError("Cet utilisateur n'est pas membre de l'espace");
    },

    /**
     * Ajoute un membre à un espace d'équipe.
     * @param workspaceId Identifiant de l'espace.
     * @param userId Identifiant de l'utilisateur ajouté.
     * @param role Rôle donné à l'utilisateur dans l'espace.
     * @returns Rien.
     * @throws AccountError Si le rôle est inconnu, l'espace ou l'utilisateur introuvable, l'espace personnel, ou le membre déjà présent.
     */
    async addMember(workspaceId: number, userId: number, role: Role): Promise<void> {
      const checked = checkRole(role);
      const workspace = await requireWorkspace(workspaceId);
      if (workspace.kind === "personal") throw new AccountError("Un espace personnel n'a qu'un seul membre : crée un espace d'équipe");
      if (!(await getUser(userId))) throw new AccountError("Utilisateur introuvable");
      const res = await db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (workspace_id, user_id) DO NOTHING", [
        workspaceId,
        userId,
        checked,
      ]);
      if (res.changes === 0) throw new AccountError("Cet utilisateur est déjà membre de l'espace");
    },

    /**
     * Change le rôle d'un membre. L'opération est refusée si elle retire à l'espace son dernier admin.
     * @param workspaceId Identifiant de l'espace.
     * @param userId Identifiant du membre.
     * @param role Nouveau rôle.
     * @returns Rien.
     * @throws AccountError Si le rôle est inconnu, l'espace personnel, le membre absent, ou s'il est le dernier admin.
     */
    async setRole(workspaceId: number, userId: number, role: Role): Promise<void> {
      const checked = checkRole(role);
      const workspace = await requireWorkspace(workspaceId);
      if (workspace.kind === "personal") throw new AccountError("Le rôle du propriétaire d'un espace personnel ne change pas");
      // Une seule instruction : le contrôle du dernier admin et la mise à jour ne peuvent pas être séparés par une autre requête
      const res = await db.run(
        `UPDATE memberships SET role = ?
          WHERE workspace_id = ? AND user_id = ?
            AND (role <> 'admin' OR ? = 'admin' OR (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND role = 'admin') > 1)`,
        [checked, workspaceId, userId, checked, workspaceId],
      );
      if (res.changes === 0) throw await refusalReason(workspaceId, userId);
    },

    /**
     * Retire un membre d'un espace d'équipe. L'opération est refusée si elle retire à l'espace son dernier admin.
     * @param workspaceId Identifiant de l'espace.
     * @param userId Identifiant du membre retiré.
     * @returns Rien.
     * @throws AccountError Si l'espace est personnel, le membre absent, ou s'il est le dernier admin.
     */
    async removeMember(workspaceId: number, userId: number): Promise<void> {
      const workspace = await requireWorkspace(workspaceId);
      if (workspace.kind === "personal") throw new AccountError("Le propriétaire d'un espace personnel ne peut pas en être retiré");
      const res = await db.run(
        `DELETE FROM memberships
          WHERE workspace_id = ? AND user_id = ?
            AND (role <> 'admin' OR (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND role = 'admin') > 1)`,
        [workspaceId, userId, workspaceId],
      );
      if (res.changes === 0) throw await refusalReason(workspaceId, userId);
    },

    /**
     * Retrouve l'utilisateur lié à un compte de forge.
     * @param provider Forge du compte (gitlab ou github).
     * @param providerUserId Identifiant numérique du compte chez la forge (il ne change jamais, contrairement au login).
     * @returns L'utilisateur, ou undefined si ce compte n'est lié à personne.
     */
    findUserByIdentity(provider: string, providerUserId: string): Promise<UserRow | undefined> {
      return db.get<UserRow>(
        "SELECT u.* FROM users u JOIN identities i ON i.user_id = u.id WHERE i.provider = ? AND i.provider_user_id = ?",
        [provider, providerUserId],
      );
    },

    /**
     * Dit si un utilisateur a déjà un compte de forge lié.
     * @param userId Identifiant de l'utilisateur.
     * @returns true si au moins un compte de forge est lié.
     */
    async userHasIdentity(userId: number): Promise<boolean> {
      return (await db.get("SELECT 1 AS found FROM identities WHERE user_id = ? LIMIT 1", [userId])) !== undefined;
    },

    /**
     * Lie un compte de forge à un utilisateur.
     * @param userId Identifiant de l'utilisateur.
     * @param provider Forge du compte (gitlab ou github).
     * @param providerUserId Identifiant numérique du compte chez la forge.
     * @param login Nom de connexion du compte chez la forge.
     * @returns Rien.
     * @throws AccountError Si le compte de forge est déjà lié (à cet utilisateur ou à un autre).
     */
    async linkIdentity(userId: number, provider: string, providerUserId: string, login: string): Promise<void> {
      const res = await db.run("INSERT INTO identities (user_id, provider, provider_user_id, login) VALUES (?, ?, ?, ?) ON CONFLICT (provider, provider_user_id) DO NOTHING", [
        userId,
        provider,
        providerUserId,
        login,
      ]);
      if (res.changes === 0) throw new AccountError("Ce compte de forge est déjà lié à un utilisateur");
    },

    /**
     * Met à jour le nom de connexion mémorisé d'un compte de forge (il peut changer chez la forge).
     * @param provider Forge du compte.
     * @param providerUserId Identifiant numérique du compte chez la forge.
     * @param login Nom de connexion actuel.
     * @returns Rien.
     */
    async updateIdentityLogin(provider: string, providerUserId: string, login: string): Promise<void> {
      await db.run("UPDATE identities SET login = ? WHERE provider = ? AND provider_user_id = ?", [login, provider, providerUserId]);
    },

    /**
     * Change le nom affiché d'un utilisateur.
     * @param userId Identifiant de l'utilisateur.
     * @param name Nouveau nom.
     * @returns Rien.
     * @throws AccountError Si le nom est invalide ou l'utilisateur inconnu.
     */
    async renameUser(userId: number, name: string): Promise<void> {
      const res = await db.run("UPDATE users SET name = ? WHERE id = ?", [cleanName(name, "Nom"), userId]);
      if (res.changes === 0) throw new AccountError("Utilisateur introuvable");
    },

    /**
     * Contexte du mode local : le premier utilisateur (créé par la migration) et son premier espace, celui de l'installation : personnel au départ,
     * d'équipe une fois transformé pour inviter du monde.
     * @returns L'utilisateur, l'espace et le rôle à utiliser quand il n'y a pas de connexion.
     * @throws AccountError Si la base ne contient aucun espace.
     */
    async localContext(): Promise<AccountContext> {
      const row = await db.get<{ user_id: number; workspace_id: number; role: Role }>(
        "SELECT m.user_id AS user_id, m.workspace_id AS workspace_id, m.role AS role FROM memberships m ORDER BY m.user_id, m.workspace_id LIMIT 1",
      );
      if (!row) throw new AccountError("Aucun espace : la base n'a pas été migrée");
      return { userId: row.user_id, workspaceId: row.workspace_id, role: row.role };
    },
  };
}
