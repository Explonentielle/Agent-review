import type { Sql } from "./db.js";

/** Espace auquel sont rattachées les données existantes : le seul qui existe à ce stade, celui de l'utilisateur local (migration 5). */
const LOCAL_WORKSPACE = "(SELECT MIN(id) FROM workspaces)";

/**
 * Migration « données rattachées à un espace » (roadmap-plateforme, C4) : reviews, tâches de dev, projets et
 * réglages portent un `workspace_id` obligatoire, et les clés d'unicité l'incluent (deux espaces peuvent
 * reviewer la même demande de fusion). Les données existantes passent dans l'espace local.
 * Les tables `actions` et `dev_task_events` restent rattachées à leur review ou tâche, donc à leur espace.
 * @param s Fragments SQL du moteur.
 * @returns Le script de migration du moteur : reconstruction des tables sur SQLite (qui ne sait pas modifier une clé), ALTER sur PostgreSQL.
 */
export function workspaceScopeMigration(s: Sql): string {
  return s.name === "sqlite" ? sqliteScript(s) : postgresScript();
}

/**
 * Script SQLite : les tables sont recréées sous un nom provisoire avec leur nouveau schéma, remplies depuis les anciennes, puis les anciennes
 * sont supprimées et les nouvelles renommées (SQLite réécrit alors les clés étrangères vers le nom définitif). Une table parente est
 * reconstruite avec ses tables filles (`actions`, `dev_task_events`) : on ne supprime jamais une table que d'autres références visent encore.
 * @param s Fragments SQL de SQLite.
 * @returns Le script.
 */
function sqliteScript(s: Sql): string {
  return `
  CREATE TABLE reviews_new (
    id               ${s.pk},
    workspace_id     INTEGER NOT NULL REFERENCES workspaces(id),
    source           TEXT    NOT NULL DEFAULT 'gitlab',
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
    updated_at       TEXT    NOT NULL ${s.nowDefault}
  );
  INSERT INTO reviews_new (id, workspace_id, source, project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha, status, decision_reasons,
                           result_json, changed_lines, cost_usd, num_turns, error, feedback_agree, feedback_note, created_at, updated_at)
    SELECT id, ${LOCAL_WORKSPACE}, source, project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha, status, decision_reasons,
           result_json, changed_lines, cost_usd, num_turns, error, feedback_agree, feedback_note, created_at, updated_at
    FROM reviews ORDER BY id;
  CREATE TABLE actions_new (
    id         ${s.pk},
    review_id  INTEGER NOT NULL REFERENCES reviews_new(id),
    kind       TEXT    NOT NULL,
    automatic  INTEGER NOT NULL,
    detail     TEXT,
    created_at TEXT    NOT NULL ${s.nowDefault}
  );
  INSERT INTO actions_new (id, review_id, kind, automatic, detail, created_at) SELECT id, review_id, kind, automatic, detail, created_at FROM actions ORDER BY id;
  DROP TABLE actions;
  DROP TABLE reviews;
  ALTER TABLE reviews_new RENAME TO reviews;
  ALTER TABLE actions_new RENAME TO actions;
  CREATE INDEX idx_reviews_status ON reviews(status);
  CREATE UNIQUE INDEX uq_reviews_head ON reviews(workspace_id, source, project_id, mr_iid, head_sha);

  CREATE TABLE dev_tasks_new (
    id                 ${s.pk},
    workspace_id       INTEGER NOT NULL REFERENCES workspaces(id),
    source             TEXT    NOT NULL DEFAULT 'gitlab',
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
    mode               TEXT    NOT NULL DEFAULT 'new',
    parent_id          INTEGER REFERENCES dev_tasks_new(id),
    created_at         TEXT    NOT NULL ${s.nowDefault},
    updated_at         TEXT    NOT NULL ${s.nowDefault}
  );
  INSERT INTO dev_tasks_new (id, workspace_id, source, project_id, project_path, issue_iid, issue_title, issue_url, extra_instructions, branch, base_branch,
                             target_branch, worktree_path, session_id, status, result_json, mr_iid, mr_url, files_changed, cost_usd, num_turns, error,
                             mode, parent_id, created_at, updated_at)
    SELECT id, ${LOCAL_WORKSPACE}, source, project_id, project_path, issue_iid, issue_title, issue_url, extra_instructions, branch, base_branch,
           target_branch, worktree_path, session_id, status, result_json, mr_iid, mr_url, files_changed, cost_usd, num_turns, error,
           mode, parent_id, created_at, updated_at
    FROM dev_tasks ORDER BY id;
  CREATE TABLE dev_task_events_new (
    id         ${s.pk},
    task_id    INTEGER NOT NULL REFERENCES dev_tasks_new(id),
    kind       TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    created_at TEXT    NOT NULL ${s.nowDefault}
  );
  INSERT INTO dev_task_events_new (id, task_id, kind, text, created_at) SELECT id, task_id, kind, text, created_at FROM dev_task_events ORDER BY id;
  DROP TABLE dev_task_events;
  DROP TABLE dev_tasks;
  ALTER TABLE dev_tasks_new RENAME TO dev_tasks;
  ALTER TABLE dev_task_events_new RENAME TO dev_task_events;
  CREATE INDEX idx_dev_tasks_ws_issue ON dev_tasks(workspace_id, source, project_id, issue_iid);
  CREATE INDEX idx_dev_task_events_task ON dev_task_events(task_id, id);

  CREATE TABLE projects_new (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    source       TEXT    NOT NULL,
    project_id   INTEGER NOT NULL,
    path         TEXT    NOT NULL,
    config       TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, source, project_id)
  );
  INSERT INTO projects_new (workspace_id, source, project_id, path, config) SELECT ${LOCAL_WORKSPACE}, source, project_id, path, config FROM projects;
  DROP TABLE projects;
  ALTER TABLE projects_new RENAME TO projects;

  CREATE TABLE settings_new (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    key          TEXT    NOT NULL,
    value        TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, key)
  );
  INSERT INTO settings_new (workspace_id, key, value) SELECT ${LOCAL_WORKSPACE}, key, value FROM settings;
  DROP TABLE settings;
  ALTER TABLE settings_new RENAME TO settings;
  `;
}

/**
 * Script PostgreSQL : colonne ajoutée, remplie, rendue obligatoire, puis clés remplacées. Les anciennes contraintes d'unicité et de clé
 * primaire sont retrouvées par leur type plutôt que par leur nom, qui dépend de l'histoire de la table.
 * @returns Le script.
 */
function postgresScript(): string {
  /** Supprime la contrainte du type donné (u : unicité, p : clé primaire) de la table. */
  const dropConstraint = (table: string, type: "u" | "p") => `
  DO $$
  DECLARE c text;
  BEGIN
    SELECT conname INTO c FROM pg_constraint WHERE conrelid = '${table}'::regclass AND contype = '${type}';
    IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', c); END IF;
  END $$;`;
  /** Ajoute `workspace_id` à la table, rempli avec l'espace local puis obligatoire. */
  const addWorkspace = (table: string) => `
  ALTER TABLE ${table} ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id);
  UPDATE ${table} SET workspace_id = ${LOCAL_WORKSPACE};
  ALTER TABLE ${table} ALTER COLUMN workspace_id SET NOT NULL;`;

  return `
  ${addWorkspace("reviews")}
  ${dropConstraint("reviews", "u")}
  CREATE UNIQUE INDEX uq_reviews_head ON reviews(workspace_id, source, project_id, mr_iid, head_sha);

  ${addWorkspace("dev_tasks")}
  DROP INDEX idx_dev_tasks_issue;
  DROP INDEX idx_dev_tasks_source_issue;
  CREATE INDEX idx_dev_tasks_ws_issue ON dev_tasks(workspace_id, source, project_id, issue_iid);

  ${addWorkspace("projects")}
  ${dropConstraint("projects", "p")}
  ALTER TABLE projects ADD PRIMARY KEY (workspace_id, source, project_id);

  ${addWorkspace("settings")}
  ${dropConstraint("settings", "p")}
  ALTER TABLE settings ADD PRIMARY KEY (workspace_id, key);
  `;
}
