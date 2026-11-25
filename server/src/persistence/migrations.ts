/**
 * Ordered, append-only schema migrations (Postgres dialect; identical for
 * PGlite and real Postgres/Supabase). Applied at boot inside a transaction,
 * tracked in `schema_migrations`, idempotent (each statement is also written
 * with IF NOT EXISTS so a half-applied manual run is harmless).
 *
 * NEVER edit a shipped migration — append a new one.
 */
import type { Db } from './db.js';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('guest','registered')),
  display_name  TEXT NOT NULL,
  username      TEXT,
  password_hash TEXT,
  external_id   TEXT,
  appearance    JSONB NOT NULL,
  created_at    BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL,
  visits        INTEGER NOT NULL DEFAULT 0,
  discoveries   JSONB NOT NULL DEFAULT '[]',
  inventory     JSONB NOT NULL DEFAULT '[]',
  last_position JSONB,
  stats         JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_uq ON profiles (username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_external_uq ON profiles (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  revoked_at  BIGINT
);
CREATE INDEX IF NOT EXISTS sessions_profile_idx ON sessions (profile_id);

CREATE TABLE IF NOT EXISTS world_kv (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_sets (
  set_name TEXT NOT NULL,
  member   TEXT NOT NULL,
  added_at BIGINT NOT NULL,
  PRIMARY KEY (set_name, member)
);

CREATE TABLE IF NOT EXISTS object_states (
  id         TEXT PRIMARY KEY,
  active     BOOLEAN NOT NULL DEFAULT FALSE,
  value      DOUBLE PRECISION NOT NULL DEFAULT 0,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_events (
  id           TEXT PRIMARY KEY,
  ts           BIGINT NOT NULL,
  kind         TEXT NOT NULL,
  actors       JSONB NOT NULL DEFAULT '[]',
  location_id  TEXT,
  object_id    TEXT,
  data         JSONB,
  significance SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS world_events_ts_idx ON world_events (ts);
CREATE INDEX IF NOT EXISTS world_events_kind_idx ON world_events (kind, id);

CREATE TABLE IF NOT EXISTS gazette_issues (
  id           TEXT PRIMARY KEY,
  issue_number INTEGER NOT NULL UNIQUE,
  published_at BIGINT NOT NULL,
  period_start BIGINT NOT NULL,
  period_end   BIGINT NOT NULL,
  doc          JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_notes (
  id              TEXT PRIMARY KEY,
  mailbox_id      TEXT NOT NULL,
  from_profile_id TEXT NOT NULL,
  from_name       TEXT NOT NULL,
  text            TEXT NOT NULL,
  ts              BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_notes_box_idx ON mail_notes (mailbox_id, ts);

CREATE TABLE IF NOT EXISTS profile_relations (
  owner_id   TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('block','mute')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (owner_id, target_id, kind)
);

CREATE TABLE IF NOT EXISTS reports (
  id                  TEXT PRIMARY KEY,
  ts                  BIGINT NOT NULL,
  reporter_profile_id TEXT NOT NULL,
  target_profile_id   TEXT NOT NULL,
  reason              TEXT NOT NULL,
  details             TEXT,
  evidence            JSONB NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS reports_ts_idx ON reports (ts);

CREATE TABLE IF NOT EXISTS sanctions (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('chat_mute','ban')),
  reason      TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT,
  created_by  TEXT NOT NULL,
  revoked_at  BIGINT
);
CREATE INDEX IF NOT EXISTS sanctions_profile_idx ON sanctions (profile_id);
`,
  },
  {
    id: 2,
    name: 'world_instance_keys',
    sql: `
ALTER TABLE world_kv ADD COLUMN IF NOT EXISTS world_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE world_kv DROP CONSTRAINT IF EXISTS world_kv_pkey;
ALTER TABLE world_kv ADD CONSTRAINT world_kv_pkey PRIMARY KEY (world_id, key);
ALTER TABLE world_sets ADD COLUMN IF NOT EXISTS world_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE world_sets DROP CONSTRAINT IF EXISTS world_sets_pkey;
ALTER TABLE world_sets ADD CONSTRAINT world_sets_pkey PRIMARY KEY (world_id, set_name, member);
ALTER TABLE object_states ADD COLUMN IF NOT EXISTS world_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE object_states DROP CONSTRAINT IF EXISTS object_states_pkey;
ALTER TABLE object_states ADD CONSTRAINT object_states_pkey PRIMARY KEY (world_id, id);
ALTER TABLE world_events ADD COLUMN IF NOT EXISTS world_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS world_events_world_idx ON world_events (world_id, id)
`,
  },
];

/** Apply pending migrations. Returns the ids applied this run. */
export async function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`);
  const done = new Set((await db.query<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => Number(r.id)));
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of splitStatements(m.sql)) await tx.query(stmt);
      await tx.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [m.id, m.name, Date.now()]);
    });
    applied.push(m.id);
  }
  return applied;
}

/** Our migrations contain no functions/strings with semicolons, so a plain split is safe. */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
