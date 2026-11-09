import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

/**
 * Migrations appliquées dans l'ordre, une seule fois chacune (suivi via PRAGMA user_version).
 * Ne jamais modifier une migration déjà appliquée : en ajouter une nouvelle à la fin.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE reviews (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
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
    cost_usd         REAL,
    num_turns        INTEGER,
    error            TEXT,
    feedback_agree   INTEGER,
    feedback_note    TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, mr_iid, head_sha)
  );
  CREATE INDEX idx_reviews_status ON reviews(status);

  CREATE TABLE actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id  INTEGER NOT NULL REFERENCES reviews(id),
    kind       TEXT    NOT NULL,
    automatic  INTEGER NOT NULL,
    detail     TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
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
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
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
    cost_usd           REAL,
    num_turns          INTEGER,
    error              TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_dev_tasks_issue ON dev_tasks(project_id, issue_iid);

  CREATE TABLE dev_task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES dev_tasks(id),
    kind       TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_dev_task_events_task ON dev_task_events(task_id, id);
  `,
  // Reprise d'une MR existante avec des consignes (roadmap, item 30)
  `
  ALTER TABLE dev_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'new';
  ALTER TABLE dev_tasks ADD COLUMN parent_id INTEGER REFERENCES dev_tasks(id);
  `,
];

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "review-agent.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
