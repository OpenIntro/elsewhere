/**
 * Bushes and small rocks players have cleared (building): Nature registers the
 * instance slot of every bush / rock it draws by id; the build sync hides a
 * cleared one (zero-scale matrix) and shows it again when it grows back.
 * Visual only — collision is the shared CollisionWorld's `disabled` set.
 */
import { Matrix4, type InstancedMesh } from 'three';

interface Slot {
  mesh: InstancedMesh;
  index: number;
  matrix: Matrix4;
}
const slots = new Map<string, Slot[]>();
const hidden = new Set<string>();
const ZERO = new Matrix4().makeScale(0, 0, 0);

function apply(id: string): void {
  for (const s of slots.get(id) ?? []) {
    s.mesh.setMatrixAt(s.index, hidden.has(id) ? ZERO : s.matrix);
    s.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Nature: forget every slot (its meshes are being rebuilt). */
export function resetNatureSlots(): void {
  slots.clear();
}
/** Nature: one drawn instance of bush / rock `id`. */
export function registerNatureSlot(id: string, mesh: InstancedMesh, index: number, matrix: Matrix4): void {
  let l = slots.get(id);
  if (!l) slots.set(id, (l = []));
  l.push({ mesh, index, matrix: matrix.clone() });
  if (hidden.has(id)) apply(id);
}
/** Build sync: these ids are cleared (true) or back (false). */
export function setNatureHidden(ids: readonly string[], on: boolean): void {
  for (const id of ids) {
    if (on) hidden.add(id);
    else hidden.delete(id);
    apply(id);
  }
}
/** Build sync: replace the whole cleared set (join snapshot). */
export function resetNatureHidden(ids: readonly string[]): void {
  const before = [...hidden];
  hidden.clear();
  for (const id of before) apply(id);
  setNatureHidden(ids, true);
}
/** Read-only (debug / tests): is this bush / rock drawn? */
export function natureVisible(id: string): boolean {
  return slots.has(id) && !hidden.has(id);
}
