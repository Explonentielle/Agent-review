import type { Db, Sql } from "./db.js";
import { workspaceScopeMigration } from "./workspaceScopeMigration.js";

/**
 * Migrations appliquées dans l'ordre, une seule fois chacune (version de schéma suivie par le moteur :
 * `PRAGMA user_version` sur SQLite, table `schema_migrations` sur PostgreSQL).
 * Ne jamais modifier une migration déjà appliquée : en ajouter une nouvelle à la fin.
 * Le SQL est commun aux deux moteurs ; seuls les types et les défauts passent par `Sql`.
 */
export function migrationsFor(s: Sql): string[] {
  return [
    `
  CREATE TABLE reviews (
    id               ${s.pk},
    project_id       INTEGER NOT NULL,
    project_path     TEXT    NOT NULL,
    mr_iid           INTEGER NOT NULL,
    mr_title         TEXT    NOT NULL,
    mr_url           TEXT    NOT NULL,
    author           TEXT    NOT NULL,
    head_sha         TEXT    NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'queued',
    decision_reasons TEXT,
    result_json      TEXT,
    changed_lines    INTEGER,
    cost_usd         ${s.real},
    num_turns        INTEGER,
    error            TEXT,
    feedback_agree   INTEGER,
    feedback_note    TEXT,
    created_at       TEXT    NOT NULL ${s.nowDefault},
    updated_at       TEXT    NOT NULL ${s.nowDefault},
    UNIQUE (project_id, mr_iid, head_sha)
  );
  CREATE INDEX idx_reviews_status ON reviews(status);

  CREATE TABLE actions (
    id         ${s.pk},
    review_id  INTEGER NOT NULL REFERENCES reviews(id),
    kind       TEXT    NOT NULL,
    automatic  INTEGER NOT NULL,
    detail     TEXT,
    created_at TEXT    NOT NULL ${s.nowDefault}
  );
  `,
    `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE projects (
    project_id INTEGER PRIMARY KEY,
    path       TEXT NOT NULL,
    config     TEXT NOT NULL
  );

  CREATE TABLE dev_tasks (
    id                 ${s.pk},
    project_id         INTEGER NOT NULL,
    project_path       TEXT    NOT NULL,
    issue_iid          INTEGER NOT NULL,
    issue_title        TEXT    NOT NULL,
    issue_url          TEXT    NOT NULL,
    extra_instructions TEXT,
    branch             TEXT,
    base_branch        TEXT,
    target_branch      TEXT,
    worktree_path      TEXT,
    session_id         TEXT,
    status             TEXT    NOT NULL DEFAULT 'queued',
    result_json        TEXT,
    mr_iid             INTEGER,
    mr_url             TEXT,
    files_changed      INTEGER,
    cost_usd           ${s.real},
    num_turns          INTEGER,
    error              TEXT,
    created_at         TEXT    NOT NULL ${s.nowDefault},
    updated_at         TEXT    NOT NULL ${s.nowDefault}
  );
  CREATE INDEX idx_dev_tasks_issue ON dev_tasks(project_id, issue_iid);

  CREATE TABLE dev_task_events (
    id         ${s.pk},
    task_id    INTEGER NOT NULL REFERENCES dev_tasks(id),
    kind       TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    created_at TEXT    NOT NULL ${s.nowDefault}
  );
  CREATE INDEX idx_dev_task_events_task ON dev_task_events(task_id, id);
  `,
    // Reprise d'une MR existante avec des consignes (roadmap, item 30)
    `
  ALTER TABLE dev_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'new';
  ALTER TABLE dev_tasks ADD COLUMN parent_id INTEGER REFERENCES dev_tasks(id);
  `,
    // Plusieurs forges : la « source » accompagne l'identifiant de projet (roadmap-plateforme, lot B).
    // Les données existantes viennent de GitLab. Les réglages de projet sont recréés avec la clé (source, project_id) ;
    // pour les reviews, la contrainte d'unicité existante reste : elle ne se heurterait que pour un même commit.
    `
  ALTER TABLE reviews ADD COLUMN source TEXT NOT NULL DEFAULT 'gitlab';
  ALTER TABLE dev_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'gitlab';
  CREATE INDEX idx_dev_tasks_source_issue ON dev_tasks(source, project_id, issue_iid);

  CREATE TABLE projects_by_source (
    source     TEXT    NOT NULL,
    project_id INTEGER NOT NULL,
    path       TEXT    NOT NULL,
    config     TEXT    NOT NULL,
    PRIMARY KEY (source, project_id)
  );
  INSERT INTO projects_by_source (source, project_id, path, config) SELECT 'gitlab', project_id, path, config FROM projects;
  DROP TABLE projects;
  ALTER TABLE projects_by_source RENAME TO projects;
  `,
    // Comptes : utilisateurs, espaces et appartenances (roadmap-plateforme, C1b). Les données existantes ne sont pas encore
    // rattachées à un espace (lot C4) ; l'outil local reçoit un utilisateur et un espace personnel dont il est l'admin.
    `
  CREATE TABLE users (
    id         ${s.pk},
    name       TEXT NOT NULL,
    email      TEXT UNIQUE,
    created_at TEXT NOT NULL ${s.nowDefault}
  );

  CREATE TABLE workspaces (
    id         ${s.pk},
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
    created_at TEXT NOT NULL ${s.nowDefault}
  );

  CREATE TABLE memberships (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    user_id      INTEGER NOT NULL REFERENCES users(id),
    role         TEXT    NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    created_at   TEXT    NOT NULL ${s.nowDefault},
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX idx_memberships_user ON memberships(user_id);

  INSERT INTO users (name) VALUES ('Utilisateur local');
  INSERT INTO workspaces (name, kind) VALUES ('Espace local', 'personal');
  INSERT INTO memberships (workspace_id, user_id, role) SELECT w.id, u.id, 'admin' FROM workspaces w, users u;
  `,
    // Secrets chiffrés (roadmap-plateforme, C3) : jamais de valeur en clair, la clé maître est hors base.
    // user_id vide : secret partagé de l'espace ; renseigné : secret personnel de cet utilisateur dans l'espace.
    `
  CREATE TABLE secrets (
    id           ${s.pk},
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    user_id      INTEGER REFERENCES users(id),
    name         TEXT    NOT NULL,
    value        TEXT    NOT NULL,
    created_at   TEXT    NOT NULL ${s.nowDefault},
    updated_at   TEXT    NOT NULL ${s.nowDefault}
  );
  CREATE UNIQUE INDEX idx_secrets_workspace ON secrets(workspace_id, name) WHERE user_id IS NULL;
  CREATE UNIQUE INDEX idx_secrets_user ON secrets(workspace_id, user_id, name) WHERE user_id IS NOT NULL;
  `,
    // Données rattachées à un espace (roadmap-plateforme, C4) : voir workspaceScopeMigration.ts
    workspaceScopeMigration(s),
    // Connexion par compte de forge (roadmap-plateforme, C2) : identités reconnues et sessions. Le jeton de session n'est jamais
    // stocké, seulement son empreinte SHA-256 ; la session porte l'espace actif, que l'utilisateur doit toujours être membre.
    `
  CREATE TABLE identities (
    id               ${s.pk},
    user_id          INTEGER NOT NULL REFERENCES users(id),
    provider         TEXT    NOT NULL CHECK (provider IN ('gitlab', 'github')),
    provider_user_id TEXT    NOT NULL,
    login            TEXT    NOT NULL,
    created_at       TEXT    NOT NULL ${s.nowDefault}
  );
  CREATE UNIQUE INDEX uq_identities_provider ON identities(provider, provider_user_id);
  CREATE INDEX idx_identities_user ON identities(user_id);

  CREATE TABLE sessions (
    token_hash   TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    created_at   TEXT    NOT NULL ${s.nowDefault},
    expires_at   TEXT    NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  `,
    // Journal d'audit des écritures sur les forges (roadmap-plateforme, C6) : qui, quand, quoi, sur quelle cible, avec quel résultat
    `
  CREATE TABLE audit_log (
    id           ${s.pk},
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    user_id      INTEGER REFERENCES users(id),
    source       TEXT    NOT NULL,
    action       TEXT    NOT NULL,
    target       TEXT    NOT NULL,
    detail       TEXT,
    outcome      TEXT    NOT NULL CHECK (outcome IN ('ok', 'error')),
    error        TEXT,
    created_at   TEXT    NOT NULL ${s.nowDefault}
  );
  CREATE INDEX idx_audit_workspace ON audit_log(workspace_id, id);
  `,
    // Invitations dans un espace d'équipe : le jeton n'est jamais stocké, seulement son empreinte SHA-256 ; il sert une seule fois, expire, et peut être
    // révoqué. forge_login (facultatif, `forge:identifiant` en minuscules) réserve l'invitation à un compte de forge.
    `
  CREATE TABLE invitations (
    id           ${s.pk},
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    token_hash   TEXT    NOT NULL,
    role         TEXT    NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    note         TEXT    NOT NULL DEFAULT '',
    forge_login  TEXT,
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT    NOT NULL ${s.nowDefault},
    expires_at   TEXT    NOT NULL,
    used_by      INTEGER REFERENCES users(id),
    used_at      TEXT,
    revoked_at   TEXT
  );
  CREATE UNIQUE INDEX uq_invitations_token ON invitations(token_hash);
  CREATE INDEX idx_invitations_workspace ON invitations(workspace_id, id);
  `,
    // Quotas par personne : celui qui a lancé la review ou la tâche (pour compter sa consommation), et ses limites propres dans l'espace
    // (vide : la valeur par défaut des réglages de l'espace ; 0 : sans limite). Les lignes déjà là n'ont pas de propriétaire connu.
    `
  ALTER TABLE reviews ADD COLUMN user_id INTEGER REFERENCES users(id);
  ALTER TABLE dev_tasks ADD COLUMN user_id INTEGER REFERENCES users(id);
  CREATE INDEX idx_reviews_user ON reviews(workspace_id, user_id);
  CREATE INDEX idx_dev_tasks_user ON dev_tasks(workspace_id, user_id);
  ALTER TABLE memberships ADD COLUMN budget_usd ${s.real};
  ALTER TABLE memberships ADD COLUMN daily_runs INTEGER;
  `,
    // Connexion par email et mot de passe. Les mots de passe vivent à part des utilisateurs (jamais lus par erreur avec un `SELECT *` sur users) et ne sont
    // gardés que sous forme d'empreinte lente. email_tokens porte les liens envoyés par email (inscription, mot de passe oublié) : seule l'empreinte SHA-256
    // du jeton est stockée, il sert une fois et expire. invitations.email réserve l'invitation à une adresse : son lien n'est alors envoyé qu'à cette adresse.
    `
  CREATE TABLE credentials (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id),
    password_hash TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL ${s.nowDefault}
  );

  CREATE TABLE email_tokens (
    id         ${s.pk},
    purpose    TEXT    NOT NULL CHECK (purpose IN ('signup', 'reset')),
    email      TEXT    NOT NULL,
    user_id    INTEGER REFERENCES users(id),
    token_hash TEXT    NOT NULL,
    created_at TEXT    NOT NULL ${s.nowDefault},
    expires_at TEXT    NOT NULL,
    used_at    TEXT
  );
  CREATE UNIQUE INDEX uq_email_tokens_hash ON email_tokens(token_hash);
  CREATE INDEX idx_email_tokens_email ON email_tokens(purpose, email);

  ALTER TABLE invitations ADD COLUMN email TEXT;
  `,
  ];
}

/** Applique les migrations manquantes, chacune dans une transaction avec la mise à jour de la version. */
export async function migrate(db: Db): Promise<void> {
  const migrations = migrationsFor(db.sql);
  const current = await db.schemaVersion();
  if (current > migrations.length) {
    throw new Error(`La base est à la version ${current} du schéma, plus récente que cet outil (${migrations.length}) : mets l'outil à jour`);
  }
  for (let version = current; version < migrations.length; version++) {
    await db.transaction(async (tx) => {
      await tx.exec(migrations[version]!);
      await tx.setSchemaVersion(version + 1);
    });
  }
}
