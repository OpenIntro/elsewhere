/**
 * Durable storage of placed pieces (table `build_pieces`, migration 3). Every
 * row carries world_id like the other world tables. Positions are stored as
 * integer half-metres (x2/z2) so they round-trip exactly.
 */
import { isPieceKind, type PieceRecord } from '@elsewhere/shared';
import type { PersistenceService } from '../persistence/index.js';

type Row = Record<string, unknown>;

export interface PieceRepository {
  loadAll(): Promise<PieceRecord[]>;
  insert(p: PieceRecord): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
}

function rowToPiece(r: Row): PieceRecord | null {
  const kind = String(r.kind);
  if (!isPieceKind(kind)) return null;
  const p: PieceRecord = {
    id: String(r.id),
    kind,
    variant: String(r.variant),
    x: Number(r.x2) / 2,
    z: Number(r.z2) / 2,
    rot: Number(r.rot),
    level: Number(r.level),
    y: Number(r.y),
    ownerId: String(r.owner_id),
    ownerName: String(r.owner_name),
    createdAt: Number(r.created_at),
  };
  if (r.text !== null && r.text !== undefined && r.text !== '') p.text = String(r.text);
  return p;
}

export function createPieceRepository(persistence: PersistenceService, worldId: string): PieceRepository {
  const { query, write } = persistence.sql;
  return {
    async loadAll() {
      const rows = await query('SELECT * FROM build_pieces WHERE world_id = $1 ORDER BY created_at ASC, id ASC', [worldId]);
      return rows.map(rowToPiece).filter((p): p is PieceRecord => p !== null);
    },
    async insert(p) {
      await write(
        `INSERT INTO build_pieces (world_id, id, kind, variant, x2, z2, rot, level, y, owner_id, owner_name, text, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [worldId, p.id, p.kind, p.variant, Math.round(p.x * 2), Math.round(p.z * 2), p.rot, p.level, p.y, p.ownerId, p.ownerName, p.text ?? null, p.createdAt ?? Date.now()],
      );
    },
    async remove(ids) {
      if (!ids.length) return;
      await write('DELETE FROM build_pieces WHERE world_id = $1 AND id = ANY($2::text[])', [worldId, [...ids]]);
    },
  };
}
