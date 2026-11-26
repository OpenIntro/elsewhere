/**
 * Build-mode input: B toggles build mode (any time), and while building R
 * rotates the piece (instead of the camera; Q still turns the camera), E is
 * swallowed (no interacting while building), Esc finishes, Enter places,
 * X/Delete switch to the remove tool, PgUp/PgDn lock the storey up/down,
 * N puts the ghost on the next segment of the run. Pointer: mouse hover aims, click places / selects; touch tap
 * aims (placing needs the explicit Place button) or selects.
 */
import { setKeyInterceptor } from '../player/index.js';
import { aimFromScreen, cancelRoofSpan, exitBuild, isBuilding, nextSegment, placeGhost, rotate, selectAt, setTool, stepStorey, toggleBuild, undo } from './actions.js';
import { useBuildStore } from './store.js';

export function installBuildInput(): () => void {
  setKeyInterceptor((code, e) => {
    if (code === 'KeyB') {
      toggleBuild();
      return true;
    }
    if (!isBuilding()) return false;
    switch (code) {
      case 'KeyR':
        rotate(e.shiftKey ? -1 : 1);
        return true;
      case 'Escape':
        if (!cancelRoofSpan()) exitBuild();
        return true;
      case 'PageUp':
        e.preventDefault();
        stepStorey(1);
        return true;
      case 'PageDown':
        e.preventDefault();
        stepStorey(-1);
        return true;
      case 'KeyN':
        nextSegment();
        return true;
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        if (useBuildStore.getState().mode === 'place') placeGhost();
        return true;
      case 'KeyX':
      case 'Delete':
        setTool(useBuildStore.getState().mode === 'remove' ? 'place' : 'remove');
        return true;
      case 'KeyZ':
        if (e.ctrlKey || e.metaKey) undo();
        return false;
      case 'KeyE':
        return true; // no interacting while building
      default:
        return false;
    }
  });
  return () => setKeyInterceptor(null);
}

/** Pointer routing while building. Returns true when the build system handled it. */
export const buildPointer = {
  tap(x: number, y: number, type: string): boolean {
    const st = useBuildStore.getState();
    if (st.mode === 'off') return false;
    if (st.mode === 'remove' || st.mode === 'clear') {
      selectAt(x, y);
      return true;
    }
    aimFromScreen(x, y);
    // Mouse/pen: click places immediately; touch: tap only aims (explicit Place button).
    if (type !== 'touch') placeGhost();
    return true;
  },
  hover(x: number, y: number): boolean {
    const st = useBuildStore.getState();
    if (st.mode !== 'place') return st.mode !== 'off';
    aimFromScreen(x, y);
    return true;
  },
};
