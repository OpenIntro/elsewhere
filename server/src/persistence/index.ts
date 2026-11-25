/**
 * Durable storage for everything that must survive a restart: accounts +
 * sessions, profiles, World Memory events, gazette issues, persistent world
 * facts / object states / unique-member sets (Collective Reality), mail and
 * moderation (relations, reports, sanctions).
 *
 * One SQL implementation (Postgres dialect) over two drivers (see db.ts):
 * embedded PGlite under DATA_DIR by default, `pg` when DATABASE_URL is set.
 * Schema lives in migrations.ts and is applied idempotently at init().
 *
 * Writes are tracked so close() can flush everything in flight (graceful shutdown).
 */
import type { Appearance, DiscoveryId, GazetteIssue, ItemId, MailNote, PersistentWorldState, ReportReason, WorldEvent, WorldEventKind, WorldMemoryQuery } from '@elsewhere/shared';
import { openDb, type Db, type DbOptions } from './db.js';
import { migrate } from './migrations.js';

/** The single world instance for now; more can be added by id (all world tables carry world_id). */
export const DEFAULT_WORLD_ID = 'default';

export interface StoredProfile {
  id: string;
  kind: 'guest' | 'registered';
  displayName: string;
  appearance: Appearance;
  /** Registered only (lower-case). */
  username?: string;
  passwordHash?: string;
  /** External identity (e.g. Supabase `sub`) for JWT-authenticated accounts. */
  externalId?: string;
  createdAt: number;
  lastSeenAt: number;
  visits: number;
  discoveries: DiscoveryId[];
  /** Items ever picked up (unique collection). */
  inventory: ItemId[];
  /** Last ground position (restored on rejoin). */
  lastPosition: { x: number; z: number } | null;
  /** Activity counters. */
  stats: Record<string, number>;
  /** Profile ids (hydrated from profile_relations; mutate through RelationRepository). */
  blocked: string[];
  muted: string[];
}

export interface StoredReport {
  id: string;
  ts: number;
  reporterProfileId: string;
  targetProfileId: string;
  reason: ReportReason;
  details?: string;
  /** Snapshot of relevant chat lines at report time. */
  evidence: string[];
  status?: 'open' | 'closed';
}

export interface StoredSession {
  tokenHash: string;
  profileId: string;
  kind: 'guest' | 'registered';
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

/** build_ban: may play and chat but not place pieces (admin tool). */
export type SanctionKind = 'chat_mute' | 'ban' | 'build_ban';
export interface StoredSanction {
  id: string;
  profileId: string;
  kind: SanctionKind;
  reason: string;
  createdAt: number;
  /** null = permanent. */
  expiresAt: number | null;
  createdBy: string;
  revokedAt: number | null;
}

export interface StoredObjectState {
  id: string;
  active: boolean;
  value: number;
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface ProfileRepository {
  get(id: string): Promise<StoredProfile | null>;
  getByUsername(username: string): Promise<StoredProfile | null>;
  getByExternalId(externalId: string): Promise<StoredProfile | null>;
  save(profile: StoredProfile): Promise<void>;
  /** Cheap partial update for frequent position persistence. */
  savePosition(id: string, pos: { x: number; z: number }, lastSeenAt: number): Promise<void>;
  /** Profiles that have ever joined (visits > 0). */
  countResidents(): Promise<number>;
}

export interface SessionRepository {
  create(session: StoredSession): Promise<void>;
  get(tokenHash: string): Promise<StoredSession | null>;
  revoke(tokenHash: string, at: number): Promise<void>;
  revokeAllForProfile(profileId: string, at: number): Promise<void>;
}

export interface WorldEventRepository {
  append(event: WorldEvent): Promise<void>;
  list(query: WorldMemoryQuery): Promise<WorldEvent[]>;
  /** Events with from <= ts < to (for gazette compilation), oldest first. */
  range(from: number, to: number): Promise<WorldEvent[]>;
  count(kind?: WorldEventKind): Promise<number>;
  /** Oldest event ts, or null. */
  firstTs(): Promise<number | null>;
}

export interface GazetteRepository {
  save(issue: GazetteIssue): Promise<void>;
  get(id: string): Promise<GazetteIssue | null>;
  list(limit: number, before?: string): Promise<GazetteIssue[]>;
  latest(): Promise<GazetteIssue | null>;
}

export interface WorldStateRepository {
  load(): Promise<PersistentWorldState | null>;
  save(state: PersistentWorldState): Promise<void>;
  /** Generic JSON key/value (e.g. portal timers). */
  getKv<T>(key: string): Promise<T | null>;
  setKv(key: string, value: unknown): Promise<void>;
  /** Set-like store for "unique contributors" style counters. Returns true if newly added. */
  addToSet(setName: string, member: string): Promise<boolean>;
  hasInSet(setName: string, member: string): Promise<boolean>;
  setSize(setName: string): Promise<number>;
  setMembers(setName: string, limit: number): Promise<string[]>;
  loadObjects(): Promise<StoredObjectState[]>;
  saveObject(state: StoredObjectState): Promise<void>;
}

export interface MailRepository {
  add(note: MailNote): Promise<void>;
  /** Newest `limit` notes, oldest first. */
  list(mailboxId: string, limit: number): Promise<MailNote[]>;
}

export interface ReportRepository {
  add(report: StoredReport): Promise<void>;
  /** Newest first. */
  list(limit: number): Promise<StoredReport[]>;
}

export interface RelationRepository {
  add(ownerId: string, targetId: string, kind: 'block' | 'mute', at: number): Promise<void>;
  remove(ownerId: string, targetId: string, kind: 'block' | 'mute'): Promise<void>;
  list(ownerId: string): Promise<{ blocked: string[]; muted: string[] }>;
}

export interface SanctionRepository {
  add(s: StoredSanction): Promise<void>;
  revoke(id: string, at: number): Promise<boolean>;
  /** Unrevoked, unexpired sanctions (optionally for one profile). */
  active(now: number, profileId?: string): Promise<StoredSanction[]>;
  list(limit: number): Promise<StoredSanction[]>;
}

export interface PersistenceService {
  readonly driver: 'pglite' | 'postgres';
  profiles: ProfileRepository;
  sessions: SessionRepository;
  events: WorldEventRepository;
  gazette: GazetteRepository;
  /** The default world instance's state (= forWorld(DEFAULT_WORLD_ID)). */
  worldState: WorldStateRepository;
  /** State of a specific world instance. */
  forWorld(worldId: string): WorldStateRepository;
  mail: MailRepository;
  reports: ReportRepository;
  relations: RelationRepository;
  sanctions: SanctionRepository;
  /**
   * Raw SQL for feature repositories that live next to their feature
   * (e.g. server/src/building/repository.ts). `write` is tracked by flush().
   */
  sql: {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    write(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  };
  init(): Promise<void>;
  /** Await every write in flight. */
  flush(): Promise<void>;
  /** Flush and close. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const json = (v: unknown): string => JSON.stringify(v ?? null);
/** jsonb may come back parsed (pg, PGlite) — accept strings defensively. */
function parsed<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

function rowToProfile(r: Row): StoredProfile {
  const p: StoredProfile = {
    id: String(r.id),
    kind: r.kind === 'registered' ? 'registered' : 'guest',
    displayName: String(r.display_name),
    appearance: parsed<Appearance>(r.appearance, {} as Appearance),
    createdAt: num(r.created_at),
    lastSeenAt: num(r.last_seen_at),
    visits: num(r.visits),
    discoveries: parsed<DiscoveryId[]>(r.discoveries, []),
    inventory: parsed<ItemId[]>(r.inventory, []),
    lastPosition: parsed<{ x: number; z: number } | null>(r.last_position, null),
    stats: parsed<Record<string, number>>(r.stats, {}),
    blocked: [],
    muted: [],
  };
  if (r.username) p.username = String(r.username);
  if (r.password_hash) p.passwordHash = String(r.password_hash);
  if (r.external_id) p.externalId = String(r.external_id);
  return p;
}

function rowToEvent(r: Row): WorldEvent {
  const e: WorldEvent = {
    id: String(r.id),
    ts: num(r.ts),
    kind: String(r.kind) as WorldEventKind,
    actors: parsed(r.actors, []),
    significance: Math.max(0, Math.min(3, num(r.significance))) as WorldEvent['significance'],
  };
  if (r.location_id) e.locationId = String(r.location_id) as NonNullable<WorldEvent['locationId']>;
  if (r.object_id) e.objectId = String(r.object_id);
  const data = parsed<WorldEvent['data'] | null>(r.data, null);
  if (data) e.data = data;
  return e;
}

function rowToSanction(r: Row): StoredSanction {
  return {
    id: String(r.id),
    profileId: String(r.profile_id),
    kind: r.kind === 'ban' ? 'ban' : r.kind === 'build_ban' ? 'build_ban' : 'chat_mute',
    reason: String(r.reason),
    createdAt: num(r.created_at),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : num(r.expires_at),
    createdBy: String(r.created_by),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : num(r.revoked_at),
  };
}

export interface PersistenceOptions extends DbOptions {}

/**
 * Create the persistence service. Defaults: DATABASE_URL → Postgres, else PGlite
 * in `dataDir`. Pass `{ dataDir: 'memory://' }` for an ephemeral DB (tests).
 */
export function createPersistence(opts: PersistenceOptions = { dataDir: 'memory://' }): PersistenceService {
  let db: Db | null = null;
  const inflight = new Set<Promise<unknown>>();
  const q = <T = Row>(sql: string, params?: unknown[]): Promise<T[]> => {
    if (!db) return Promise.reject(new Error('persistence.init() not called'));
    return db.query<T>(sql, params);
  };
  /** Track a write so flush()/close() can await it. */
  const w = async (sql: string, params?: unknown[]): Promise<Row[]> => {
    const p = q(sql, params);
    inflight.add(p);
    try {
      return await p;
    } finally {
      inflight.delete(p);
    }
  };

  const profiles: ProfileRepository = {
    async get(id) {
      const rows = await q('SELECT * FROM profiles WHERE id = $1', [id]);
      if (!rows[0]) return null;
      const p = rowToProfile(rows[0]);
      Object.assign(p, await relations.list(p.id));
      return p;
    },
    async getByUsername(username) {
      const rows = await q('SELECT id FROM profiles WHERE username = $1', [username.toLowerCase()]);
      return rows[0] ? profiles.get(String(rows[0].id)) : null;
    },
    async getByExternalId(externalId) {
      const rows = await q('SELECT id FROM profiles WHERE external_id = $1', [externalId]);
      return rows[0] ? profiles.get(String(rows[0].id)) : null;
    },
    async save(p) {
      await w(
        `INSERT INTO profiles (id, kind, display_name, username, password_hash, external_id, appearance, created_at, last_seen_at, visits, discoveries, inventory, last_position, stats)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, display_name = EXCLUDED.display_name, username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash, external_id = EXCLUDED.external_id, appearance = EXCLUDED.appearance,
           last_seen_at = EXCLUDED.last_seen_at, visits = EXCLUDED.visits, discoveries = EXCLUDED.discoveries,
           inventory = EXCLUDED.inventory, last_position = EXCLUDED.last_position, stats = EXCLUDED.stats`,
        [
          p.id,
          p.kind,
          p.displayName,
          p.username ?? null,
          p.passwordHash ?? null,
          p.externalId ?? null,
          json(p.appearance),
          p.createdAt,
          p.lastSeenAt,
          p.visits,
          json(p.discoveries ?? []),
          json(p.inventory ?? []),
          p.lastPosition ? json(p.lastPosition) : null,
          json(p.stats ?? {}),
        ],
      );
    },
    async savePosition(id, pos, lastSeenAt) {
      await w('UPDATE profiles SET last_position = $2, last_seen_at = $3 WHERE id = $1', [id, json(pos), lastSeenAt]);
    },
    async countResidents() {
      const rows = await q<{ n: unknown }>('SELECT COUNT(*) AS n FROM profiles WHERE visits > 0');
      return num(rows[0]?.n);
    },
  };

  const sessions: SessionRepository = {
    async create(s) {
      await w('INSERT INTO sessions (token_hash, profile_id, kind, created_at, expires_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6)', [
        s.tokenHash,
        s.profileId,
        s.kind,
        s.createdAt,
        s.expiresAt,
        s.revokedAt,
      ]);
    },
    async get(tokenHash) {
      const r = (await q('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash]))[0];
      if (!r) return null;
      return {
        tokenHash: String(r.token_hash),
        profileId: String(r.profile_id),
        kind: r.kind === 'registered' ? 'registered' : 'guest',
        createdAt: num(r.created_at),
        expiresAt: num(r.expires_at),
        revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : num(r.revoked_at),
      };
    },
    async revoke(tokenHash, at) {
      await w('UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash, at]);
    },
    async revokeAllForProfile(profileId, at) {
      await w('UPDATE sessions SET revoked_at = $2 WHERE profile_id = $1 AND revoked_at IS NULL', [profileId, at]);
    },
  };

  const events: WorldEventRepository = {
    async append(e) {
      await w('INSERT INTO world_events (id, ts, kind, actors, location_id, object_id, data, significance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        e.id,
        e.ts,
        e.kind,
        json(e.actors),
        e.locationId ?? null,
        e.objectId ?? null,
        e.data ? json(e.data) : null,
        e.significance,
      ]);
    },
    async list(query) {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, v: unknown) => {
        params.push(v);
        where.push(clause.replace('?', `$${params.length}`));
      };
      if (query.before) add('id < ?', query.before);
      if (query.kind) add('kind = ?', query.kind);
      if (query.locationId) add('location_id = ?', query.locationId);
      if (query.profileId) add('actors @> ?::jsonb', json([{ profileId: query.profileId }]));
      params.push(Math.min(500, Math.max(1, query.limit ?? 50)));
      const rows = await q(`SELECT * FROM world_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
      return rows.map(rowToEvent);
    },
    async range(from, to) {
      return (await q('SELECT * FROM world_events WHERE ts >= $1 AND ts < $2 ORDER BY id ASC LIMIT 5000', [from, to])).map(rowToEvent);
    },
    async count(kind) {
      const rows = kind ? await q<{ n: unknown }>('SELECT COUNT(*) AS n FROM world_events WHERE kind = $1', [kind]) : await q<{ n: unknown }>('SELECT COUNT(*) AS n FROM world_events');
      return num(rows[0]?.n);
    },
    async firstTs() {
      const rows = await q<{ t: unknown }>('SELECT MIN(ts) AS t FROM world_events');
      return rows[0]?.t === null || rows[0]?.t === undefined ? null : num(rows[0].t);
    },
  };

  const gazette: GazetteRepository = {
    async save(issue) {
      await w(
        `INSERT INTO gazette_issues (id, issue_number, published_at, period_start, period_end, doc) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`,
        [issue.id, issue.issueNumber, issue.publishedAt, issue.periodStart, issue.periodEnd, json(issue)],
      );
    },
    async get(id) {
      const r = (await q('SELECT doc FROM gazette_issues WHERE id = $1', [id]))[0];
      return r ? parsed<GazetteIssue | null>(r.doc, null) : null;
    },
    async list(limit, before) {
      let rows: Row[];
      if (before) {
        rows = await q(
          'SELECT doc FROM gazette_issues WHERE issue_number < (SELECT issue_number FROM gazette_issues WHERE id = $1) ORDER BY issue_number DESC LIMIT $2',
          [before, limit],
        );
      } else {
        rows = await q('SELECT doc FROM gazette_issues ORDER BY issue_number DESC LIMIT $1', [limit]);
      }
      return rows.map((r) => parsed<GazetteIssue>(r.doc, null as unknown as GazetteIssue)).filter(Boolean);
    },
    async latest() {
      const r = (await q('SELECT doc FROM gazette_issues ORDER BY issue_number DESC LIMIT 1'))[0];
      return r ? parsed<GazetteIssue | null>(r.doc, null) : null;
    },
  };

  /** World-instance-scoped facts, kv, sets and object states (every row carries world_id). */
  const forWorld = (worldId: string): WorldStateRepository => {
    const repo: WorldStateRepository = {
      async load() {
        return repo.getKv<PersistentWorldState>('facts');
      },
      async save(st) {
        await repo.setKv('facts', st);
      },
      async getKv<T>(key: string) {
        const r = (await q('SELECT value FROM world_kv WHERE world_id = $1 AND key = $2', [worldId, key]))[0];
        return r ? parsed<T | null>(r.value, null) : null;
      },
      async setKv(key, value) {
        await w(
          'INSERT INTO world_kv (world_id, key, value, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (world_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at',
          [worldId, key, json(value), Date.now()],
        );
      },
      async addToSet(setName, member) {
        const rows = await w('INSERT INTO world_sets (world_id, set_name, member, added_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING member', [worldId, setName, member, Date.now()]);
        return rows.length > 0;
      },
      async hasInSet(setName, member) {
        return (await q('SELECT 1 FROM world_sets WHERE world_id = $1 AND set_name = $2 AND member = $3', [worldId, setName, member])).length > 0;
      },
      async setSize(setName) {
        const rows = await q<{ n: unknown }>('SELECT COUNT(*) AS n FROM world_sets WHERE world_id = $1 AND set_name = $2', [worldId, setName]);
        return num(rows[0]?.n);
      },
      async setMembers(setName, limit) {
        return (await q<{ member: string }>('SELECT member FROM world_sets WHERE world_id = $1 AND set_name = $2 ORDER BY added_at ASC LIMIT $3', [worldId, setName, limit])).map((r) => r.member);
      },
      async loadObjects() {
        return (await q('SELECT * FROM object_states WHERE world_id = $1', [worldId])).map((r) => ({
          id: String(r.id),
          active: Boolean(r.active),
          value: num(r.value),
          data: parsed<Record<string, unknown>>(r.data, {}),
          updatedAt: num(r.updated_at),
        }));
      },
      async saveObject(o) {
        await w(
          `INSERT INTO object_states (world_id, id, active, value, data, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (world_id, id) DO UPDATE SET active = EXCLUDED.active, value = EXCLUDED.value, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [worldId, o.id, o.active, o.value, json(o.data), o.updatedAt],
        );
      },
    };
    return repo;
  };
  const worldState = forWorld(DEFAULT_WORLD_ID);

  const mail: MailRepository = {
    async add(n) {
      await w('INSERT INTO mail_notes (id, mailbox_id, from_profile_id, from_name, text, ts) VALUES ($1,$2,$3,$4,$5,$6)', [n.id, n.mailboxId, n.fromProfileId, n.fromName, n.text, n.ts]);
    },
    async list(mailboxId, limit) {
      const rows = await q('SELECT * FROM mail_notes WHERE mailbox_id = $1 ORDER BY ts DESC, id DESC LIMIT $2', [mailboxId, limit]);
      return rows
        .map((r) => ({ id: String(r.id), mailboxId: String(r.mailbox_id), fromProfileId: String(r.from_profile_id), fromName: String(r.from_name), text: String(r.text), ts: num(r.ts) }))
        .reverse();
    },
  };

  const reports: ReportRepository = {
    async add(r) {
      await w('INSERT INTO reports (id, ts, reporter_profile_id, target_profile_id, reason, details, evidence, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        r.id,
        r.ts,
        r.reporterProfileId,
        r.targetProfileId,
        r.reason,
        r.details ?? null,
        json(r.evidence),
        r.status ?? 'open',
      ]);
    },
    async list(limit) {
      return (await q('SELECT * FROM reports ORDER BY ts DESC LIMIT $1', [limit])).map((r) => {
        const out: StoredReport = {
          id: String(r.id),
          ts: num(r.ts),
          reporterProfileId: String(r.reporter_profile_id),
          targetProfileId: String(r.target_profile_id),
          reason: String(r.reason) as ReportReason,
          evidence: parsed<string[]>(r.evidence, []),
          status: r.status === 'closed' ? 'closed' : 'open',
        };
        if (r.details) out.details = String(r.details);
        return out;
      });
    },
  };

  const relations: RelationRepository = {
    async add(owner, target, kind, at) {
      await w('INSERT INTO profile_relations (owner_id, target_id, kind, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [owner, target, kind, at]);
    },
    async remove(owner, target, kind) {
      await w('DELETE FROM profile_relations WHERE owner_id = $1 AND target_id = $2 AND kind = $3', [owner, target, kind]);
    },
    async list(owner) {
      const rows = await q<{ target_id: string; kind: string }>('SELECT target_id, kind FROM profile_relations WHERE owner_id = $1 ORDER BY created_at', [owner]);
      return { blocked: rows.filter((r) => r.kind === 'block').map((r) => r.target_id), muted: rows.filter((r) => r.kind === 'mute').map((r) => r.target_id) };
    },
  };

  const sanctions: SanctionRepository = {
    async add(s) {
      await w('INSERT INTO sanctions (id, profile_id, kind, reason, created_at, expires_at, created_by, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        s.id,
        s.profileId,
        s.kind,
        s.reason,
        s.createdAt,
        s.expiresAt,
        s.createdBy,
        s.revokedAt,
      ]);
    },
    async revoke(id, at) {
      return (await w('UPDATE sanctions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id, at])).length > 0;
    },
    async active(now, profileId) {
      const rows = profileId
        ? await q('SELECT * FROM sanctions WHERE profile_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at DESC', [profileId, now])
        : await q('SELECT * FROM sanctions WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $1) ORDER BY created_at DESC LIMIT 500', [now]);
      return rows.map(rowToSanction);
    },
    async list(limit) {
      return (await q('SELECT * FROM sanctions ORDER BY created_at DESC LIMIT $1', [limit])).map(rowToSanction);
    },
  };

  const flush = async () => {
    while (inflight.size) await Promise.allSettled([...inflight]);
  };

  return {
    get driver() {
      return db?.kind ?? (opts.databaseUrl ? 'postgres' : 'pglite');
    },
    profiles,
    sessions,
    events,
    gazette,
    worldState,
    forWorld,
    mail,
    reports,
    relations,
    sanctions,
    sql: { query: q, write: w },
    async init() {
      if (db) return;
      db = await openDb(opts);
      await migrate(db);
    },
    flush,
    async close() {
      if (!db) return;
      await flush();
      const d = db;
      db = null;
      await d.close();
    },
  };
}
