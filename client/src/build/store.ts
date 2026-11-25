/**
 * Build-mode UI state (low frequency → zustand) and the client's copy of the
 * world's pieces (module-level index, NOT React state: thousands of pieces
 * are read by the renderer through `pieces.version`).
 */
import { create } from 'zustand';
import { PIECES, PieceIndex, type PieceKind, type PieceRecord } from '@elsewhere/shared';

export type BuildMode = 'off' | 'place' | 'remove';

export interface GhostState {
  x: number;
  z: number;
  level: number;
  y: number;
  ok: boolean;
  message: string;
}

export interface BuildUiState {
  mode: BuildMode;
  kind: PieceKind;
  /** Chosen variant per kind. */
  variants: Partial<Record<PieceKind, string>>;
  rot: number;
  signText: string;
  ghost: GhostState | null;
  /** Piece selected with the remove tool (own → Remove, others → Report). */
  selected: string | null;
  /** Last server refusal (shown for a moment). */
  refusal: { text: string; at: number } | null;
  /** Ids this player placed this session, newest last (undo). */
  undo: string[];
  /** Waiting for a server answer. */
  pending: number;
  /** True once the join snapshot has fully arrived. */
  synced: boolean;
  /** Bumped when pieces change (UI counters). */
  version: number;
  /** Palette thumbnails (data URLs) rendered from the real templates. */
  thumbs: Record<string, string>;
  /** Palette tab. */
  category: string;
  set(p: Partial<BuildUiState>): void;
}

export const useBuildStore = create<BuildUiState>()((set) => ({
  mode: 'off',
  kind: 'floor',
  variants: {},
  rot: 0,
  signText: '',
  ghost: null,
  selected: null,
  refusal: null,
  undo: [],
  pending: 0,
  synced: false,
  version: 0,
  thumbs: {},
  category: 'structure',
  set: (p) => set(p),
}));

export function variantFor(kind: PieceKind): string {
  return useBuildStore.getState().variants[kind] ?? PIECES[kind].variants[0]!.id;
}

/** The client's copy of every piece in the world (authoritative data from the server). */
export const pieces = {
  index: new PieceIndex<PieceRecord>(),
  /** Increments on every change; renderers compare against their last seen value. */
  version: 0,
  /** Kinds touched since the renderer last rebuilt (null = everything). */
  dirtyKinds: new Set<PieceKind>() as Set<PieceKind> | null,
};

export function markDirty(kind: PieceKind | null): void {
  if (kind === null) pieces.dirtyKinds = null;
  else pieces.dirtyKinds?.add(kind);
  pieces.version++;
}
