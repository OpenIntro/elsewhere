/**
 * Build-mode UI state (low frequency → zustand) and the client's copy of the
 * world's pieces (module-level index, NOT React state: thousands of pieces
 * are read by the renderer through `pieces.version`).
 */
import { create } from 'zustand';
import { PIECES, PieceIndex, type PieceKind, type PieceRecord, type RoofStyle } from '@elsewhere/shared';

/** place = build; remove = pick your pieces to remove (others' to report); clear = bushes / small rocks. */
export type BuildMode = 'off' | 'place' | 'remove' | 'clear';

export interface GhostState {
  x: number;
  z: number;
  level: number;
  /** The piece's own rotation (stacking and wall mounts pick it; usually the chosen one). */
  rot: number;
  y: number;
  ok: boolean;
  message: string;
  /** House roof: the parametric size/style (RoofParams JSON). */
  params?: string;
  /** Refused only because of a clearable bush / rock: which one (the UI offers "Clear"). */
  natureId?: string;
  /** The wall this placement extends upward (highlighted). */
  extend?: string;
  /** House roof tool: a two-corner span is being drawn from this corner. */
  anchor?: { x: number; z: number };
}

export interface BuildUiState {
  mode: BuildMode;
  kind: PieceKind;
  /** Chosen variant per kind. */
  variants: Partial<Record<PieceKind, string>>;
  rot: number;
  signText: string;
  ghost: GhostState | null;
  /** Piece selected with the remove tool (own → Remove / Edit, others → Report). */
  selected: string | null;
  /** Bush / rock selected with the clear (or remove) tool. */
  selectedNature: string | null;
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
  /** Palette search ("" = show the tab). */
  query: string;
  /** Storey control: null = automatic (build on what you point at), else the ghost stays on this storey. */
  lockLevel: number | null;
  /** House roof options. */
  roofStyle: RoofStyle;
  roofPitch: 0 | 1;
  /** Text piece being edited (own sign / name board). */
  editing: string | null;
  /** Cleared bushes / rocks (ids), mirrored from the server. */
  cleared: ReadonlySet<string>;
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
  selectedNature: null,
  refusal: null,
  undo: [],
  pending: 0,
  synced: false,
  version: 0,
  thumbs: {},
  category: 'structure',
  query: '',
  lockLevel: null,
  roofStyle: 'gable',
  roofPitch: 1,
  editing: null,
  cleared: new Set<string>(),
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
