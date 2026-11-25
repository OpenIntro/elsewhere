/**
 * EXTENSION SEAM — owned by the server worker.
 *
 * Storage for everything that must survive a restart: profiles, world events
 * (World Memory), gazette issues, persistent world facts (Collective Reality),
 * mail, moderation (blocks/mutes/reports).
 *
 * The foundation ships an in-memory implementation so the slice runs. Replace
 * `createPersistence()` with a durable store (JSON files / SQLite under
 * ENV.dataDir) keeping these interfaces.
 */
import type { Appearance, GazetteIssue, MailNote, PersistentWorldState, ReportReason, WorldEvent, WorldMemoryQuery } from '@elsewhere/shared';
import type { DiscoveryId } from '@elsewhere/shared';

export interface StoredProfile {
  id: string;
  kind: 'guest' | 'registered';
  displayName: string;
  appearance: Appearance;
  /** Registered only. */
  username?: string;
  passwordHash?: string;
  createdAt: number;
  lastSeenAt: number;
  visits: number;
  discoveries: DiscoveryId[];
  /** Profile ids. */
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
}

export interface ProfileRepository {
  get(id: string): Promise<StoredProfile | null>;
  getByUsername(username: string): Promise<StoredProfile | null>;
  save(profile: StoredProfile): Promise<void>;
}

export interface WorldEventRepository {
  append(event: WorldEvent): Promise<void>;
  list(query: WorldMemoryQuery): Promise<WorldEvent[]>;
  /** Events with from <= ts < to (for gazette compilation). */
  range(from: number, to: number): Promise<WorldEvent[]>;
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
  /** Set-like store for "unique contributors" style counters (e.g. fountain). Returns true if newly added. */
  addToSet(setName: string, member: string): Promise<boolean>;
  setSize(setName: string): Promise<number>;
}

export interface MailRepository {
  add(note: MailNote): Promise<void>;
  list(mailboxId: string, limit: number): Promise<MailNote[]>;
}

export interface ReportRepository {
  add(report: StoredReport): Promise<void>;
  list(limit: number): Promise<StoredReport[]>;
}

export interface PersistenceService {
  profiles: ProfileRepository;
  events: WorldEventRepository;
  gazette: GazetteRepository;
  worldState: WorldStateRepository;
  mail: MailRepository;
  reports: ReportRepository;
  init(): Promise<void>;
  /** Flush and close. */
  close(): Promise<void>;
}

/** In-memory placeholder (data is lost on restart). */
export function createPersistence(): PersistenceService {
  const profiles = new Map<string, StoredProfile>();
  const events: WorldEvent[] = [];
  const issues: GazetteIssue[] = [];
  const sets = new Map<string, Set<string>>();
  const mail: MailNote[] = [];
  const reports: StoredReport[] = [];
  let world: PersistentWorldState | null = null;

  return {
    profiles: {
      async get(id) {
        return profiles.get(id) ?? null;
      },
      async getByUsername(username) {
        for (const p of profiles.values()) if (p.username === username) return p;
        return null;
      },
      async save(p) {
        profiles.set(p.id, p);
      },
    },
    events: {
      async append(e) {
        events.push(e);
      },
      async list(q) {
        let out = events.slice().reverse();
        if (q.before) {
          const idx = out.findIndex((e) => e.id === q.before);
          out = idx >= 0 ? out.slice(idx + 1) : out;
        }
        if (q.kind) out = out.filter((e) => e.kind === q.kind);
        if (q.locationId) out = out.filter((e) => e.locationId === q.locationId);
        if (q.profileId) out = out.filter((e) => e.actors.some((a) => a.profileId === q.profileId));
        return out.slice(0, q.limit ?? 50);
      },
      async range(from, to) {
        return events.filter((e) => e.ts >= from && e.ts < to);
      },
    },
    gazette: {
      async save(issue) {
        issues.push(issue);
      },
      async get(id) {
        return issues.find((i) => i.id === id) ?? null;
      },
      async list(limit, before) {
        let out = issues.slice().reverse();
        if (before) {
          const idx = out.findIndex((i) => i.id === before);
          out = idx >= 0 ? out.slice(idx + 1) : out;
        }
        return out.slice(0, limit);
      },
      async latest() {
        return issues[issues.length - 1] ?? null;
      },
    },
    worldState: {
      async load() {
        return world;
      },
      async save(s) {
        world = s;
      },
      async addToSet(name, member) {
        let s = sets.get(name);
        if (!s) sets.set(name, (s = new Set()));
        if (s.has(member)) return false;
        s.add(member);
        return true;
      },
      async setSize(name) {
        return sets.get(name)?.size ?? 0;
      },
    },
    mail: {
      async add(n) {
        mail.push(n);
      },
      async list(mailboxId, limit) {
        return mail.filter((m) => m.mailboxId === mailboxId).slice(-limit);
      },
    },
    reports: {
      async add(r) {
        reports.push(r);
      },
      async list(limit) {
        return reports.slice(-limit);
      },
    },
    async init() {},
    async close() {},
  };
}
