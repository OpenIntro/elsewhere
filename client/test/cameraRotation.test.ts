/**
 * View rotation: the settled four orientations, the eased tween, live drag /
 * twist rotation that settles to the nearest 90°, the two-finger gesture
 * classifier (pinch vs twist) and screen-relative movement at each orientation.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  BASE_YAW,
  ROTATE_MS,
  cameraControls,
  cameraRuntime,
  classifyTwoFinger,
  nearestRotation,
  rotateMsFor,
  screenToWorldDir,
  tweenYaw,
  useCameraStore,
  yawOfRotation,
} from '../src/player/camera.js';

const Q = Math.PI / 2;
const deg = (d: number) => (d * Math.PI) / 180;

describe('rotation state and easing', () => {
  it('four settled orientations; any yaw rounds to the nearest one', () => {
    for (let r = -4; r <= 4; r++) expect(nearestRotation(yawOfRotation(r))).toBe(r);
    expect(nearestRotation(yawOfRotation(1) + deg(44))).toBe(1);
    expect(nearestRotation(yawOfRotation(1) + deg(46))).toBe(2);
    expect(nearestRotation(yawOfRotation(0) - deg(46))).toBe(-1);
  });

  it('the tween eases from → to without overshoot and ends exactly on the target', () => {
    const from = yawOfRotation(0);
    const to = yawOfRotation(1);
    let prev = from;
    for (let t = 0; t <= ROTATE_MS; t += ROTATE_MS / 24) {
      const y = tweenYaw(from, to, 1000, ROTATE_MS, 1000 + t);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(y).toBeLessThanOrEqual(to + 1e-12);
      prev = y;
    }
    expect(tweenYaw(from, to, 1000, ROTATE_MS, 1000)).toBe(from);
    expect(tweenYaw(from, to, 1000, ROTATE_MS, 1000 + ROTATE_MS)).toBe(to);
    // gentle at both ends (ease-in-out): the first 10% of the time covers well under 10% of the turn
    expect(tweenYaw(from, to, 0, ROTATE_MS, ROTATE_MS * 0.1) - from).toBeLessThan(0.02 * Q);
    // a small settle after a drag is quicker than a full step, never instant
    expect(rotateMsFor(Q)).toBe(ROTATE_MS);
    expect(rotateMsFor(deg(10))).toBeGreaterThanOrEqual(160);
    expect(rotateMsFor(deg(10))).toBeLessThan(ROTATE_MS);
  });

  it('buttons / keys step 90° from where the view is heading; a drag follows live and settles to the nearest step', () => {
    useCameraStore.setState({ rotation: 0 });
    cameraRuntime.yaw = BASE_YAW;
    cameraRuntime.dragYaw = null;
    cameraControls.rotateRight();
    expect(useCameraStore.getState().rotation).toBe(1);
    expect(cameraRuntime.yawTo).toBeCloseTo(BASE_YAW + Q, 12);
    cameraControls.rotateRight();
    expect(useCameraStore.getState().rotation).toBe(2);
    cameraControls.rotateLeft();
    cameraControls.rotateLeft();
    expect(useCameraStore.getState().rotation).toBe(0);

    cameraRuntime.yaw = BASE_YAW;
    cameraControls.dragRotate(deg(30));
    expect(cameraControls.isDragRotating()).toBe(true);
    expect(cameraRuntime.dragYaw).toBeCloseTo(BASE_YAW + deg(30), 12);
    cameraControls.dragRotate(deg(20)); // 50° in total → settles one step on
    cameraControls.endDragRotate();
    expect(cameraControls.isDragRotating()).toBe(false);
    expect(useCameraStore.getState().rotation).toBe(1);
    expect(cameraRuntime.yawFrom).toBeCloseTo(BASE_YAW + deg(50), 12);
    expect(cameraRuntime.yawTo).toBeCloseTo(BASE_YAW + Q, 12);

    cameraRuntime.yaw = BASE_YAW + Q;
    cameraControls.dragRotate(-deg(30)); // not far enough: back to where it was
    cameraControls.endDragRotate();
    expect(useCameraStore.getState().rotation).toBe(1);
    expect(cameraRuntime.yawTo).toBeCloseTo(BASE_YAW + Q, 12);
  });
});

describe('two-finger gestures: pinch vs twist', () => {
  it('small motions stay undecided', () => {
    expect(classifyTwoFinger(deg(5), Math.log(1.03))).toBe('undecided');
    expect(classifyTwoFinger(0, 0)).toBe('undecided');
  });
  it('a pinch with the usual incidental finger turn is a pinch (never rotates)', () => {
    expect(classifyTwoFinger(deg(6), Math.log(1.3))).toBe('pinch');
    expect(classifyTwoFinger(-deg(9), Math.log(0.75))).toBe('pinch');
    expect(classifyTwoFinger(deg(11), Math.log(1.6))).toBe('pinch');
  });
  it('a twist with a little distance change is a twist, both directions', () => {
    expect(classifyTwoFinger(deg(25), Math.log(1.05))).toBe('twist');
    expect(classifyTwoFinger(-deg(18), Math.log(0.97))).toBe('twist');
  });
  it('the dominant motion wins when both are large', () => {
    expect(classifyTwoFinger(deg(40), Math.log(1.1))).toBe('twist');
    expect(classifyTwoFinger(deg(14), Math.log(1.5))).toBe('pinch');
  });
});

describe('screen-relative movement at each orientation', () => {
  for (let r = 0; r < 4; r++) {
    it(`rotation ${r}: up = away from the camera, right = screen right`, () => {
      const yaw = yawOfRotation(r);
      const toCam = { x: Math.sin(yaw), z: Math.cos(yaw) };
      const up = screenToWorldDir(0, 1, yaw, { x: 0, z: 0 });
      expect(up.x).toBeCloseTo(-toCam.x, 12);
      expect(up.z).toBeCloseTo(-toCam.z, 12);
      const right = screenToWorldDir(1, 0, yaw, { x: 0, z: 0 });
      expect(right.x).toBeCloseTo(Math.cos(yaw), 12);
      expect(right.z).toBeCloseTo(-Math.sin(yaw), 12);
      // … the same directions the camera really shows: its right axis and its view direction on the ground
      const cam = new PerspectiveCamera();
      cam.position.set(toCam.x * 50, 40, toCam.z * 50);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld(true);
      const camRight = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      expect(right.x).toBeCloseTo(camRight.x, 9);
      expect(right.z).toBeCloseTo(camRight.z, 9);
      const fwd = cam.getWorldDirection(new Vector3());
      const fl = Math.hypot(fwd.x, fwd.z);
      expect(up.x).toBeCloseTo(fwd.x / fl, 9);
      expect(up.z).toBeCloseTo(fwd.z / fl, 9);
    });
  }
});
