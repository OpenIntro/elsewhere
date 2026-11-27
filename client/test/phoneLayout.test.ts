/**
 * Phone layout logic (Brief B): the landscape build strip's dock state machine,
 * the peek sheet transitions, and the camera focus-shift math (a framed point
 * lands inside the free part of the screen at every camera yaw).
 */
import { describe, expect, it } from 'vitest';
import { OrthographicCamera, Vector3 } from 'three';
import { dockLayout, dockReducer, type DockState } from '../src/build/store.js';
import { BASE_YAW, ELEVATION, freeRectFor, lookAtForShift, shiftForFree, type ScreenRect } from '../src/player/camera.js';
import { sheetAfterDrag, sheetAfterEvent, SHEET_DRAG_CLOSE, SHEET_DRAG_OPEN, SHEET_DRAG_SETTLE } from '../src/ui/primitives.js';

describe('landscape build strip: dock state machine', () => {
  const closed: DockState = { open: false, palette: false, kind: 'floor' };

  it('enter in landscape → collapsed strip; chip → palette; pick → collapsed with the new piece; Done → closed', () => {
    let s = dockReducer(closed, { type: 'enter' });
    expect(dockLayout(s, true)).toBe('strip');
    s = dockReducer(s, { type: 'chip' });
    expect(dockLayout(s, true)).toBe('strip-palette');
    s = dockReducer(s, { type: 'pick', kind: 'wall' });
    expect(dockLayout(s, true)).toBe('strip');
    expect(s.kind).toBe('wall');
    s = dockReducer(s, { type: 'done' });
    expect(dockLayout(s, true)).toBe('closed');
    expect(s.kind).toBe('wall');
  });

  it('the chip toggles the palette; Close collapses it; nothing opens while closed', () => {
    let s = dockReducer(closed, { type: 'enter' });
    s = dockReducer(dockReducer(s, { type: 'chip' }), { type: 'chip' });
    expect(dockLayout(s, true)).toBe('strip');
    s = dockReducer(dockReducer(s, { type: 'chip' }), { type: 'collapse' });
    expect(dockLayout(s, true)).toBe('strip');
    expect(dockReducer(closed, { type: 'chip' })).toEqual(closed);
  });

  it('an orientation change keeps the chosen piece; portrait shows the full dock', () => {
    let s = dockReducer(closed, { type: 'enter' });
    s = dockReducer(dockReducer(s, { type: 'chip' }), { type: 'pick', kind: 'doorway' });
    s = dockReducer(s, { type: 'chip' });
    expect(dockLayout(s, false)).toBe('dock'); // rotated to portrait
    s = dockReducer(s, { type: 'orient' });
    expect(s.kind).toBe('doorway');
    expect(dockLayout(s, true)).toBe('strip'); // and back to landscape: collapsed, same piece
    expect(s.kind).toBe('doorway');
  });

  it('entering again always starts collapsed', () => {
    const s = dockReducer({ open: false, palette: true, kind: 'sign' }, { type: 'enter' });
    expect(dockLayout(s, true)).toBe('strip');
    expect(s.kind).toBe('sign');
  });
});

describe('peek sheets', () => {
  it('drag: up → full, down from full → peek, down from peek → closed, small drags change nothing', () => {
    expect(sheetAfterDrag('peek', -SHEET_DRAG_OPEN)).toBe('full');
    expect(sheetAfterDrag('peek', -10)).toBe('peek');
    expect(sheetAfterDrag('full', SHEET_DRAG_SETTLE)).toBe('peek');
    expect(sheetAfterDrag('full', 20)).toBe('full');
    expect(sheetAfterDrag('full', -80)).toBe('full');
    expect(sheetAfterDrag('peek', SHEET_DRAG_CLOSE)).toBe('closed');
    expect(sheetAfterDrag('peek', SHEET_DRAG_CLOSE - 1)).toBe('peek');
  });

  it('handle tap toggles; text entry goes full; close closes', () => {
    expect(sheetAfterEvent('peek', 'handle')).toBe('full');
    expect(sheetAfterEvent('full', 'handle')).toBe('peek');
    expect(sheetAfterEvent('peek', 'text-focus')).toBe('full');
    expect(sheetAfterEvent('full', 'text-focus')).toBe('full');
    expect(sheetAfterEvent('peek', 'close')).toBe('closed');
    expect(sheetAfterEvent('full', 'close')).toBe('closed');
  });
});

describe('camera focus shift', () => {
  const W = 390;
  const H = 844;

  it('free rect: a bottom sheet cuts the bottom, a right side sheet cuts the right, a full-height cover is ignored', () => {
    const sheet: ScreenRect = { left: 0, top: H * 0.61, right: W, bottom: H };
    expect(freeRectFor(W, H, [sheet], 56)).toEqual({ left: 0, top: 56, right: W, bottom: H * 0.61 });
    const side: ScreenRect = { left: 915 * 0.38, top: 50, right: 907, bottom: 412 };
    expect(freeRectFor(915, 412, [side], 56)).toEqual({ left: 0, top: 56, right: 915 * 0.38, bottom: 412 });
    const strip: ScreenRect = { left: 152, top: 320, right: 763, bottom: 406 };
    expect(freeRectFor(915, 412, [strip], 56)).toEqual({ left: 0, top: 56, right: 915, bottom: 320 });
    const full: ScreenRect = { left: 0, top: 60, right: W, bottom: H };
    expect(freeRectFor(W, H, [full], 56)).toEqual({ left: 0, top: 56, right: W, bottom: H });
    expect(shiftForFree(W, H, freeRectFor(W, H, [], 56), 56)).toEqual({ x: 0, y: 0 });
  });

  /** The rig's camera for a look-at point (same placement as CameraRig). */
  function rigCamera(look: { x: number; z: number }, yaw: number, zoom: number, w: number, h: number): OrthographicCamera {
    const c = new OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 1, 220);
    c.zoom = zoom;
    const D = 70;
    const hd = Math.cos(ELEVATION) * D;
    c.position.set(look.x + Math.sin(yaw) * hd, Math.sin(ELEVATION) * D, look.z + Math.cos(yaw) * hd);
    c.lookAt(look.x, 0, look.z);
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return c;
  }
  const toScreen = (c: OrthographicCamera, p: { x: number; z: number }, w: number, h: number) => {
    const v = new Vector3(p.x, 0, p.z).project(c);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  };

  for (const [w, h, cover, label] of [
    [390, 844, { left: 0, top: 844 * 0.61, right: 390, bottom: 844 }, 'portrait peek sheet'],
    [915, 412, { left: 152, top: 320, right: 763, bottom: 406 }, 'landscape strip'],
    [915, 412, { left: 347, top: 50, right: 907, bottom: 412 }, 'landscape side sheet'],
  ] as const) {
    it(`a target point lands inside the free rect at all four yaws (${label})`, () => {
      const free = freeRectFor(w, h, [cover], 56);
      const shift = shiftForFree(w, h, free, 56);
      expect(Math.hypot(shift.x, shift.y)).toBeGreaterThan(10);
      const target = { x: 12.3, z: -7.8 };
      for (let r = 0; r < 4; r++) {
        for (const extra of [0, 0.37]) {
          const yaw = BASE_YAW + (r * Math.PI) / 2 + extra;
          const zoom = 33.6;
          const look = lookAtForShift(target.x, target.z, shift.x, shift.y, yaw, zoom);
          const p = toScreen(rigCamera(look, yaw, zoom, w, h), target, w, h);
          // exactly at the free rect's centre …
          expect(p.x).toBeCloseTo((free.left + free.right) / 2, 3);
          expect(p.y).toBeCloseTo((free.top + free.bottom) / 2, 3);
          // … so inside it, clear of the cover
          expect(p.x > free.left && p.x < free.right && p.y > free.top && p.y < free.bottom).toBe(true);
          const inCover = p.x > cover.left && p.x < cover.right && p.y > cover.top && p.y < cover.bottom;
          expect(inCover).toBe(false);
        }
      }
    });
  }

  it('no shift → the look-at is the target itself (desktop / nothing covering)', () => {
    expect(lookAtForShift(3, 4, 0, 0, BASE_YAW, 70)).toEqual({ x: 3, z: 4 });
  });
});
