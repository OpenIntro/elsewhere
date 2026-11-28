/**
 * Durable storage of homes (table `homes`, migration 6): one row per profile
 * per world, identified by its door piece. No room rectangle is stored — the
 * room is recomputed from the owner's pieces (shared/src/homes.ts).
 */
import type { PersistenceService } from '../persistence/index.js';

export interface HomeRow {
  profileId: string;
  doorPieceId: string;
  showOnMap: boolean;
  createdAt: number;
}

export interface HomeRepository {
  loadAll(): Promise<HomeRow[]>;
  /** Insert or move (one row per profile). */
  upsert(row: HomeRow): Promise<void>;
  setPin(profileId: string, on: boolean): Promise<void>;
  remove(profileId: string): Promise<void>;
}

const bool = (v: unknown) => v === true || v === 't' || v === 'true' || v === 1;

export function createHomeRepository(persistence: PersistenceService, worldId: string): HomeRepository {
  const { query, write } = persistence.sql;
  return {
    async loadAll() {
      const rows = await query('SELECT profile_id, door_piece_id, show_on_map, created_at FROM homes WHERE world_id = $1 ORDER BY created_at ASC, profile_id ASC', [worldId]);
      return rows.map((r) => ({ profileId: String(r.profile_id), doorPieceId: String(r.door_piece_id), showOnMap: bool(r.show_on_map), createdAt: Number(r.created_at) }));
    },
    async upsert(h) {
      await write(
        `INSERT INTO homes (world_id, profile_id, door_piece_id, show_on_map, created_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (world_id, profile_id) DO UPDATE SET door_piece_id = EXCLUDED.door_piece_id, created_at = EXCLUDED.created_at`,
        [worldId, h.profileId, h.doorPieceId, h.showOnMap, h.createdAt],
      );
    },
    async setPin(profileId, on) {
      await write('UPDATE homes SET show_on_map = $3 WHERE world_id = $1 AND profile_id = $2', [worldId, profileId, on]);
    },
    async remove(profileId) {
      await write('DELETE FROM homes WHERE world_id = $1 AND profile_id = $2', [worldId, profileId]);
    },
  };
}
