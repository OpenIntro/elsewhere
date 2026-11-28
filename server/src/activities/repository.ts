/**
 * Storage for building activities that are records, not counters:
 *  - activity_notes: Town Hall notices, home guest books, the boathouse tide log
 *    (moderated text, owner/admin removal, optional expiry);
 *  - poll_votes: one row per (poll period, profile) — the primary key IS the
 *    "one vote per profile" rule.
 * Counters / sets / small JSON state use the world kv + sets (persistence.forWorld).
 */
import type { PersistenceService } from '../persistence/index.js';

export interface StoredNote {
  id: string;
  boardId: string;
  profileId: string;
  authorName: string;
  text: string;
  createdAt: number;
  expiresAt: number | null;
  removedAt: number | null;
  removedBy: string | null;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const opt = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function rowToNote(r: Row): StoredNote {
  return {
    id: String(r.id),
    boardId: String(r.board_id),
    profileId: String(r.profile_id),
    authorName: String(r.author_name),
    text: String(r.text),
    createdAt: num(r.created_at),
    expiresAt: opt(r.expires_at),
    removedAt: opt(r.removed_at),
    removedBy: r.removed_by === null || r.removed_by === undefined ? null : String(r.removed_by),
  };
}

export interface ActivityRepository {
  addNote(n: StoredNote): Promise<void>;
  /** Newest `limit` visible notes of a board (not removed, not expired at `now`), oldest first. */
  visibleNotes(boardId: string, now: number, limit: number): Promise<StoredNote[]>;
  getNote(id: string): Promise<StoredNote | null>;
  /** Returns false if it did not exist or was already removed. */
  removeNote(id: string, at: number, by: string): Promise<boolean>;
  /** Active (visible) notes of one profile on one board. */
  countActive(boardId: string, profileId: string, now: number): Promise<number>;
  /** Admin listing (newest first, removed included). */
  listNotes(boardId: string | undefined, limit: number): Promise<StoredNote[]>;
  /** Inserts the vote; false if this profile already voted in this poll. */
  addVote(pollKey: string, profileId: string, option: number, at: number): Promise<boolean>;
  voteOf(pollKey: string, profileId: string): Promise<number | null>;
  tallies(pollKey: string, options: number): Promise<number[]>;
  /** Voters (oldest first). */
  voters(pollKey: string, limit: number): Promise<string[]>;
}

export function createActivityRepository(persistence: PersistenceService, worldId: string): ActivityRepository {
  const { query: q, write: w } = persistence.sql;
  return {
    async addNote(n) {
      await w(
        'INSERT INTO activity_notes (world_id, id, board_id, profile_id, author_name, text, created_at, expires_at, removed_at, removed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [worldId, n.id, n.boardId, n.profileId, n.authorName, n.text, n.createdAt, n.expiresAt, n.removedAt, n.removedBy],
      );
    },
    async visibleNotes(boardId, now, limit) {
      const rows = await q(
        'SELECT * FROM activity_notes WHERE world_id = $1 AND board_id = $2 AND removed_at IS NULL AND (expires_at IS NULL OR expires_at > $3) ORDER BY created_at DESC, id DESC LIMIT $4',
        [worldId, boardId, now, limit],
      );
      return rows.map(rowToNote).reverse();
    },
    async getNote(id) {
      const r = (await q('SELECT * FROM activity_notes WHERE world_id = $1 AND id = $2', [worldId, id]))[0];
      return r ? rowToNote(r) : null;
    },
    async removeNote(id, at, by) {
      return (await w('UPDATE activity_notes SET removed_at = $3, removed_by = $4 WHERE world_id = $1 AND id = $2 AND removed_at IS NULL RETURNING id', [worldId, id, at, by])).length > 0;
    },
    async countActive(boardId, profileId, now) {
      const rows = await q<{ n: unknown }>(
        'SELECT COUNT(*) AS n FROM activity_notes WHERE world_id = $1 AND board_id = $2 AND profile_id = $3 AND removed_at IS NULL AND (expires_at IS NULL OR expires_at > $4)',
        [worldId, boardId, profileId, now],
      );
      return num(rows[0]?.n);
    },
    async listNotes(boardId, limit) {
      const rows = boardId
        ? await q('SELECT * FROM activity_notes WHERE world_id = $1 AND board_id = $2 ORDER BY created_at DESC LIMIT $3', [worldId, boardId, limit])
        : await q('SELECT * FROM activity_notes WHERE world_id = $1 ORDER BY created_at DESC LIMIT $2', [worldId, limit]);
      return rows.map(rowToNote);
    },
    async addVote(pollKey, profileId, option, at) {
      const rows = await w('INSERT INTO poll_votes (world_id, poll_key, profile_id, option, voted_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING profile_id', [worldId, pollKey, profileId, option, at]);
      return rows.length > 0;
    },
    async voteOf(pollKey, profileId) {
      const r = (await q<{ option: unknown }>('SELECT option FROM poll_votes WHERE world_id = $1 AND poll_key = $2 AND profile_id = $3', [worldId, pollKey, profileId]))[0];
      return r ? num(r.option) : null;
    },
    async tallies(pollKey, options) {
      const out = Array.from({ length: options }, () => 0);
      const rows = await q<{ option: unknown; n: unknown }>('SELECT option, COUNT(*) AS n FROM poll_votes WHERE world_id = $1 AND poll_key = $2 GROUP BY option', [worldId, pollKey]);
      for (const r of rows) {
        const i = num(r.option);
        if (i >= 0 && i < options) out[i] = num(r.n);
      }
      return out;
    },
    async voters(pollKey, limit) {
      return (await q<{ profile_id: string }>('SELECT profile_id FROM poll_votes WHERE world_id = $1 AND poll_key = $2 ORDER BY voted_at ASC LIMIT $3', [worldId, pollKey, limit])).map((r) => r.profile_id);
    },
  };
}
