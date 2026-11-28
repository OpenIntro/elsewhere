/**
 * Procedural animation: weighted cross-fades between full-body base states
 * (idle / walk / run / sit / dance), an upper-body one-shot layer (wave /
 * interact) that returns to the base state when done, and additive layers
 * (blink, look-around, expressions, carry pose, hair spring, breathing).
 *
 * Pose buffers hold per-bone offsets from the rest pose:
 *   [rx, ry, rz, px, py, pz, sx, sy, sz]  (scale as delta from 1)
 */
import type { Bone } from 'three';
import { CONFIG, type AnimState } from '@elsewhere/shared';
import { B, BONE_COUNT, type RigLayout } from './rig.js';

const CH = 9;
type Pose = Float32Array;

export type BaseState = 'idle' | 'walk' | 'run' | 'sit' | 'dance';
export type OneShot = 'wave' | 'interact';
const BASE_STATES: readonly BaseState[] = ['idle', 'walk', 'run', 'sit', 'dance'];
const ONE_SHOT_DURATION: Record<OneShot, number> = { wave: 2.0, interact: 1.0 };

/** Bones driven by the one-shot layer (upper body). */
const UPPER_MASK = [B.spine, B.head, B.shoulderL, B.elbowL, B.shoulderR, B.elbowR];

export interface AnimInputs {
  anim: AnimState;
  animSeq: number;
  /** Ground speed in m/s (optional; tunes cadence). */
  speed?: number;
  sitStyle: 'seat' | 'ground';
  holding: boolean;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;

function set(o: Pose, b: number, ch: number, v: number) {
  o[b * CH + ch] = v;
}
function add(o: Pose, b: number, ch: number, v: number) {
  o[b * CH + ch]! += v;
}
// channel ids
const RX = 0, RY = 1, RZ = 2, PX = 3, PY = 4, PZ = 5, SX = 6, SY = 7, SZ = 8;

/** Squash/stretch on a bone: positive = stretch up, volume roughly preserved. */
function squash(o: Pose, b: number, s: number) {
  add(o, b, SY, s);
  add(o, b, SX, -s * 0.5);
  add(o, b, SZ, -s * 0.5);
}

interface PoseCtx {
  t: number;
  phase: number;
  L: RigLayout;
  seed: number;
  sitStyle: 'seat' | 'ground';
  oneShotT: number;
  danceT: number;
}

function armsRest(o: Pose) {
  set(o, B.shoulderL, RZ, 0.16);
  set(o, B.shoulderR, RZ, -0.16);
  set(o, B.elbowL, RX, -0.12);
  set(o, B.elbowR, RX, -0.12);
}

const POSES: Record<BaseState | OneShot, (o: Pose, c: PoseCtx) => void> = {
  idle(o, c) {
    const t = c.t;
    const br = Math.sin((t * TAU) / 3.6);
    armsRest(o);
    // breathing: chest swells, shoulders rise a hair
    squash(o, B.spine, 0.014 * br);
    add(o, B.shoulderL, PY, 0.004 * br);
    add(o, B.shoulderR, PY, 0.004 * br);
    add(o, B.shoulderL, RZ, 0.03 * br);
    add(o, B.shoulderR, RZ, -0.03 * br);
    // slow weight shift between feet
    const ws = Math.sin((t * TAU) / 7.3 + c.seed * 3);
    const wsS = Math.sign(ws) * Math.pow(Math.abs(ws), 0.6);
    set(o, B.hips, PX, 0.018 * wsS);
    set(o, B.hips, RZ, -0.035 * wsS);
    set(o, B.spine, RZ, 0.04 * wsS);
    set(o, B.head, RZ, -0.025 * wsS + 0.02 * Math.sin(t * 0.9 + c.seed));
    set(o, B.hipL, RZ, 0.035 * wsS);
    set(o, B.hipR, RZ, 0.035 * wsS);
    // relaxed knee on the unweighted leg
    set(o, B.kneeL, RX, 0.12 * clamp01(-wsS));
    set(o, B.hipL, RX, -0.06 * clamp01(-wsS));
    set(o, B.kneeR, RX, 0.12 * clamp01(wsS));
    set(o, B.hipR, RX, -0.06 * clamp01(wsS));
    set(o, B.hips, PY, -0.006 * Math.abs(wsS));
    squash(o, B.root, 0.008 * br);
  },
  walk(o, c) {
    const s = Math.sin(c.phase);
    const co = Math.cos(c.phase);
    armsRest(o);
    set(o, B.hipL, RX, -0.55 * s);
    set(o, B.hipR, RX, 0.55 * s);
    set(o, B.kneeL, RX, 0.15 + 0.75 * Math.max(0, co));
    set(o, B.kneeR, RX, 0.15 + 0.75 * Math.max(0, -co));
    const bob = Math.cos(2 * c.phase);
    set(o, B.hips, PY, 0.028 * bob - 0.012);
    set(o, B.hips, RY, 0.14 * s);
    set(o, B.hips, RZ, 0.06 * co);
    set(o, B.spine, RY, -0.2 * s);
    set(o, B.spine, RX, 0.07);
    set(o, B.spine, RZ, -0.04 * co);
    set(o, B.head, RY, 0.07 * s);
    set(o, B.head, RX, -0.03 * bob);
    set(o, B.head, RZ, 0.03 * co);
    add(o, B.shoulderL, RX, 0.5 * s);
    add(o, B.shoulderR, RX, -0.5 * s);
    add(o, B.elbowL, RX, -0.25 - 0.2 * Math.max(0, -s));
    add(o, B.elbowR, RX, -0.25 - 0.2 * Math.max(0, s));
    squash(o, B.root, 0.025 * bob);
  },
  run(o, c) {
    const s = Math.sin(c.phase);
    const co = Math.cos(c.phase);
    armsRest(o);
    set(o, B.hipL, RX, -0.95 * s - 0.15);
    set(o, B.hipR, RX, 0.95 * s - 0.15);
    set(o, B.kneeL, RX, 0.35 + 1.3 * Math.max(0, co));
    set(o, B.kneeR, RX, 0.35 + 1.3 * Math.max(0, -co));
    const b = Math.abs(Math.cos(c.phase)); // 1 = mid-flight, 0 = contact
    set(o, B.hips, PY, 0.07 * b - 0.04);
    set(o, B.hips, RY, 0.18 * s);
    set(o, B.spine, RX, 0.32);
    set(o, B.spine, RY, -0.26 * s);
    set(o, B.head, RX, -0.2);
    set(o, B.head, RY, 0.08 * s);
    add(o, B.shoulderL, RX, 1.0 * s - 0.2);
    add(o, B.shoulderR, RX, -1.0 * s - 0.2);
    add(o, B.shoulderL, RZ, 0.15);
    add(o, B.shoulderR, RZ, -0.15);
    set(o, B.elbowL, RX, -1.45);
    set(o, B.elbowR, RX, -1.45);
    // land squash, flight stretch
    squash(o, B.root, 0.07 * b - 0.04);
  },
  sit(o, c) {
    const t = c.t;
    const p = c.L.p;
    const ground = c.sitStyle === 'ground';
    // Root is at the seat surface: drop the hips so the pelvis rests on it.
    const pelvisBottom = 0.13;
    set(o, B.hips, PY, pelvisBottom + 0.005 - c.L.hipsY);
    set(o, B.hips, PZ, -0.04);
    set(o, B.hipL, RX, -1.5);
    set(o, B.hipR, RX, -1.5);
    set(o, B.hipL, RZ, ground ? 0.18 : 0.06);
    set(o, B.hipR, RZ, ground ? -0.18 : -0.06);
    // dangling feet, kicking in a lazy, intermittent rhythm
    const kickOn = smooth(Math.sin(t * 0.37 + c.seed * 5) * 2 - 0.4);
    const k = Math.sin(t * 4.2) * 0.32 * kickOn;
    set(o, B.kneeL, RX, ground ? 0.2 : 1.15 + k);
    set(o, B.kneeR, RX, ground ? 0.2 : 1.15 - k);
    const br = Math.sin((t * TAU) / 4);
    squash(o, B.spine, 0.012 * br);
    set(o, B.spine, RX, -0.06 + 0.015 * br);
    // hands resting on the knees / lap
    set(o, B.shoulderL, RX, -0.75);
    set(o, B.shoulderR, RX, -0.75);
    set(o, B.shoulderL, RZ, 0.12);
    set(o, B.shoulderR, RZ, -0.12);
    set(o, B.elbowL, RX, -0.45);
    set(o, B.elbowR, RX, -0.45);
    set(o, B.head, RZ, 0.06 * Math.sin(t * 0.6 + c.seed));
    set(o, B.head, RX, 0.03 * Math.sin(t * 0.43));
    void p;
  },
  dance(o, c) {
    const beat = c.danceT * (112 / 60);
    const b = beat * TAU;
    const half = b / 2;
    // 8-beat blend between "raise the roof" (A) and "side shimmy" (B), smooth, no pops.
    const k = 0.5 + 0.5 * Math.sin((beat / 8) * TAU);
    const bounce = 0.5 - 0.5 * Math.cos(b);
    set(o, B.hips, PY, -0.045 * bounce);
    set(o, B.hips, PX, 0.05 * Math.sin(half));
    set(o, B.hips, RZ, 0.12 * Math.sin(half));
    set(o, B.hips, RY, 0.25 * Math.sin(half) * (1 - k));
    set(o, B.spine, RZ, -0.16 * Math.sin(half));
    set(o, B.spine, RX, 0.06 * bounce);
    set(o, B.head, RZ, 0.18 * Math.sin(half + 0.5));
    set(o, B.head, RX, -0.1 * bounce + 0.05);
    // knees pump on the beat; one leg kicks out in pattern B
    const kick = Math.max(0, Math.sin(half)) * (1 - k);
    set(o, B.kneeL, RX, 0.4 * bounce + 0.5 * kick);
    set(o, B.kneeR, RX, 0.4 * bounce);
    set(o, B.hipL, RX, -0.3 * bounce - 0.5 * kick);
    set(o, B.hipR, RX, -0.3 * bounce);
    set(o, B.hipL, RZ, 0.06 + 0.12 * kick);
    set(o, B.hipR, RZ, -0.06);
    // arms: A = alternating overhead pumps, B = bent-arm shimmy
    const pumpL = 0.5 + 0.5 * Math.sin(b);
    const pumpR = 0.5 - 0.5 * Math.sin(b);
    const aLz = 1.75 + 0.45 * pumpL;
    const aRz = -(1.75 + 0.45 * pumpR);
    const bLx = -0.9 + 0.5 * Math.sin(half);
    const bRx = -0.9 - 0.5 * Math.sin(half);
    set(o, B.shoulderL, RZ, k * aLz + (1 - k) * 0.5);
    set(o, B.shoulderR, RZ, k * aRz - (1 - k) * 0.5);
    set(o, B.shoulderL, RX, k * -0.45 + (1 - k) * bLx);
    set(o, B.shoulderR, RX, k * -0.45 + (1 - k) * bRx);
    set(o, B.elbowL, RX, k * (-0.4 - 0.6 * pumpL) + (1 - k) * -1.5);
    set(o, B.elbowR, RX, k * (-0.4 - 0.6 * pumpR) + (1 - k) * -1.5);
    squash(o, B.root, -0.05 * bounce + 0.02);
    set(o, B.root, RY, 0.35 * Math.sin(b / 4) * k);
  },
  wave(o, c) {
    const t = c.oneShotT;
    // right arm up and out, forearm wags side to side
    // Upper arm out to the side, forearm up and wagging: keeps the hand clear of the big head's silhouette.
    set(o, B.shoulderR, RZ, -1.6 - 0.08 * Math.sin(t * TAU * 1.3));
    set(o, B.shoulderR, RY, 0.3);
    set(o, B.elbowR, RZ, -1.15 + 0.4 * Math.sin(t * TAU * 2.6));
    set(o, B.shoulderL, RZ, 0.2);
    set(o, B.elbowL, RX, -0.15);
    set(o, B.spine, RZ, 0.1);
    set(o, B.spine, RX, -0.03);
    set(o, B.head, RZ, 0.16 + 0.04 * Math.sin(t * TAU * 1.3));
    set(o, B.head, RX, -0.06);
  },
  interact(o, c) {
    const t = c.oneShotT / ONE_SHOT_DURATION.interact;
    const reach = smooth(t / 0.35) * (1 - smooth((t - 0.65) / 0.35));
    set(o, B.shoulderR, RX, -0.2 - 1.25 * reach);
    set(o, B.shoulderR, RZ, -0.16 + 0.1 * reach);
    set(o, B.elbowR, RX, -0.6 + 0.45 * reach);
    set(o, B.shoulderL, RZ, 0.2);
    set(o, B.shoulderL, RX, 0.1 * reach);
    set(o, B.elbowL, RX, -0.2);
    set(o, B.spine, RX, 0.06 + 0.2 * reach);
    set(o, B.head, RX, 0.14 * reach);
    set(o, B.head, RY, -0.08 * reach);
  },
};

export class Animator {
  private weights: Record<BaseState, number> = { idle: 1, walk: 0, run: 0, sit: 0, dance: 0 };
  private pose: Pose = new Float32Array(BONE_COUNT * CH);
  private tmp: Pose = new Float32Array(BONE_COUNT * CH);
  private one: Pose = new Float32Array(BONE_COUNT * CH);
  private t: number;
  private phase = 0;
  private danceT = 0;
  private lastAnim: AnimState | null = null;
  private lastSeq: number | null = null;
  private oneShot: OneShot | null = null;
  private oneShotT = 0;
  private oneShotW = 0;
  private oneShotKind: OneShot = 'wave';
  private baseAfter: BaseState = 'idle';
  private lastBase: BaseState = 'idle';
  private happy = 0;
  private focus = 0;
  private holdW = 0;
  // blink
  private blinkTimer: number;
  private blinkT = -1;
  private doubleBlink = false;
  // look-around
  private lookTimer: number;
  private look = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, vYaw: 0, vPitch: 0 };
  // hair spring
  private hair = { x: 0, v: 0, prevHipsY: 0 };
  private markerT = 0;
  readonly seed: number;

  constructor(seed = Math.random()) {
    this.seed = seed;
    this.t = seed * 100;
    this.blinkTimer = 1 + seed * 3;
    this.lookTimer = 1.5 + seed * 4;
  }

  /** Current expression weights (for debugging / gallery). */
  get state() {
    return { weights: { ...this.weights }, oneShot: this.oneShot, oneShotW: this.oneShotW, happy: this.happy, focus: this.focus };
  }

  private triggers(inp: AnimInputs) {
    const changed = inp.anim !== this.lastAnim || inp.animSeq !== this.lastSeq;
    if (!changed) return;
    const anim = inp.anim;
    if (anim === 'wave' || anim === 'interact') {
      // (Re)start the one-shot; it fades back into the base state when done.
      this.oneShot = anim;
      this.oneShotKind = anim;
      this.oneShotT = 0;
      this.baseAfter = this.lastBase === 'sit' ? 'sit' : 'idle';
    } else {
      this.oneShot = null;
      this.baseAfter = anim as BaseState;
      this.lastBase = anim as BaseState;
      if (anim === 'dance' && (this.lastAnim !== 'dance' || inp.animSeq !== this.lastSeq)) this.danceT = 0;
    }
    this.lastAnim = anim;
    this.lastSeq = inp.animSeq;
  }

  update(dt: number, inp: AnimInputs, L: RigLayout) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.t += dt;
    this.danceT += dt;
    this.markerT += dt;
    this.triggers(inp);

    // one-shot timing
    if (this.oneShot) {
      this.oneShotT += dt;
      if (this.oneShotT >= ONE_SHOT_DURATION[this.oneShot]) this.oneShot = null;
    } else if (this.oneShotW > 0.001) {
      this.oneShotT += dt;
    }
    const base: BaseState = BASE_STATES.includes(inp.anim as BaseState) ? (inp.anim as BaseState) : this.baseAfter;

    // cross-fade weights (exponential approach; snappier into motion than out of it)
    const tau = base === 'sit' || this.weights.sit > 0.5 ? 0.22 : 0.14;
    const k = 1 - Math.exp(-dt / tau);
    for (const s of BASE_STATES) this.weights[s] += ((s === base ? 1 : 0) - this.weights[s]) * k;
    this.oneShotW += ((this.oneShot ? 1 : 0) - this.oneShotW) * (1 - Math.exp(-dt / 0.16));

    // locomotion phase shared by walk + run (no desync during blends)
    const ww = this.weights.walk;
    const wr = this.weights.run;
    const sp = inp.speed;
    const walkHz = 1.85 * (sp && ww > wr ? Math.pow(Math.max(0.3, sp / CONFIG.movement.walkSpeed), 0.6) : 1);
    const runHz = 2.55 * (sp && wr >= ww ? Math.pow(Math.max(0.3, sp / CONFIG.movement.runSpeed), 0.6) : 1);
    const lw = ww + wr;
    const hz = lw > 0.001 ? (walkHz * ww + runHz * wr) / lw : walkHz;
    this.phase = (this.phase + dt * hz * TAU) % (TAU * 1000);

    const ctx: PoseCtx = { t: this.t, phase: this.phase, L, seed: this.seed, sitStyle: inp.sitStyle, oneShotT: this.oneShotT, danceT: this.danceT };
    const pose = this.pose;
    pose.fill(0);
    let total = 0;
    for (const s of BASE_STATES) total += this.weights[s];
    for (const s of BASE_STATES) {
      const w = this.weights[s] / (total || 1);
      if (w < 0.002) continue;
      this.tmp.fill(0);
      POSES[s](this.tmp, ctx);
      for (let i = 0; i < pose.length; i++) pose[i]! += this.tmp[i]! * w;
    }

    // upper-body one-shot layer
    const ow = smooth(this.oneShotW);
    if (ow > 0.002) {
      this.one.fill(0);
      POSES[this.oneShotKind](this.one, ctx);
      for (const b of UPPER_MASK) {
        for (let ch = 0; ch < CH; ch++) {
          const i = b * CH + ch;
          // keep base locomotion bob on the spine/head, override the rest
          pose[i] = b === B.spine || b === B.head ? pose[i]! * (1 - ow * 0.6) + this.one[i]! * ow : pose[i]! * (1 - ow) + this.one[i]! * ow;
        }
      }
    }

    // carry pose (left hand)
    this.holdW += ((inp.holding ? 1 : 0) - this.holdW) * (1 - Math.exp(-dt / 0.2));
    if (this.holdW > 0.002) {
      const h = this.holdW * (1 - this.weights.dance * 0.7);
      const i = B.shoulderL * CH;
      pose[i + RX] = pose[i + RX]! * (1 - h) + (-0.5 + pose[i + RX]! * 0.25) * h;
      pose[i + RZ] = pose[i + RZ]! * (1 - h) + 0.05 * h;
      pose[i + RY] = pose[i + RY]! * (1 - h) + -0.35 * h;
      const e = B.elbowL * CH;
      pose[e + RX] = pose[e + RX]! * (1 - h) + -1.25 * h;
    }

    // look-around (idle / sit)
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      const r = Math.random();
      this.look.tYaw = r < 0.35 ? 0 : (Math.random() - 0.5) * 1.1;
      this.look.tPitch = (Math.random() - 0.6) * 0.25;
      this.lookTimer = 2 + Math.random() * 4.5;
    }
    const calm = (this.weights.idle + this.weights.sit) * (1 - ow);
    const lk = this.look;
    // critically damped follow
    const stiff = 40;
    const damp = 2 * Math.sqrt(stiff);
    lk.vYaw += ((lk.tYaw - lk.yaw) * stiff - lk.vYaw * damp) * dt;
    lk.yaw += lk.vYaw * dt;
    lk.vPitch += ((lk.tPitch - lk.pitch) * stiff - lk.vPitch * damp) * dt;
    lk.pitch += lk.vPitch * dt;
    pose[B.head * CH + RY]! += lk.yaw * calm * 0.75;
    pose[B.spine * CH + RY]! += lk.yaw * calm * 0.15;
    pose[B.head * CH + RX]! += lk.pitch * calm;

    // expressions
    const happyT = Math.max(this.weights.dance, this.oneShotKind === 'wave' ? ow : 0);
    const focusT = this.oneShotKind === 'interact' ? ow : 0;
    const ek = 1 - Math.exp(-dt / 0.1);
    this.happy += (happyT - this.happy) * ek;
    this.focus += (focusT - this.focus) * ek;
    // blink
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.doubleBlink = Math.random() < 0.2;
      this.blinkTimer = 2.2 + Math.random() * 3.5;
    }
    let lid = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const dur = 0.16;
      const x = this.blinkT / dur;
      lid = 1 - Math.sin(Math.min(1, x) * Math.PI) * 0.92;
      if (x >= 1) {
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.blinkT = -0.0001 - 0.08; // brief pause then blink again
          this.blinkTimer = 0.08;
        } else this.blinkT = -1;
      }
    }
    const happy = this.happy;
    const focus = this.focus * (1 - happy);
    const openS = Math.max(0.001, (1 - happy) * lid) - 1;
    for (const b of [B.eyeL, B.eyeR]) {
      pose[b * CH + SY] = openS;
      pose[b * CH + SX] = (1 - happy) * 1 - 1 + 0.001 + focus * 0.08;
    }
    const hs = Math.max(0.001, happy) - 1;
    for (const b of [B.eyeHappyL, B.eyeHappyR]) {
      pose[b * CH + SX] = hs;
      pose[b * CH + SY] = hs;
    }
    const mBase = Math.max(0.001, 1 - happy - focus) - 1;
    pose[B.mouth * CH + SX] = mBase;
    pose[B.mouth * CH + SY] = mBase;
    pose[B.mouthHappy * CH + SX] = Math.max(0.001, happy) - 1;
    pose[B.mouthHappy * CH + SY] = Math.max(0.001, happy) * (1 + 0.12 * Math.sin(this.t * 9)) - 1;
    pose[B.mouthO * CH + SX] = Math.max(0.001, focus) - 1;
    pose[B.mouthO * CH + SY] = Math.max(0.001, focus) - 1;
    const browUp = 0.02 * happy + 0.012 * focus + 0.006 * Math.max(0, Math.sin(this.t * 0.7 + this.seed * 9)) * calm;
    pose[B.browL * CH + PY] = browUp;
    pose[B.browR * CH + PY] = browUp;
    pose[B.browL * CH + RZ] = -0.12 * happy;
    pose[B.browR * CH + RZ] = 0.12 * happy;

    // hair spring follows vertical motion of the hips + lean
    const hipsY = pose[B.hips * CH + PY]!;
    const vy = (hipsY - this.hair.prevHipsY) / Math.max(dt, 1e-3);
    this.hair.prevHipsY = hipsY;
    const target = -vy * 0.9 + pose[B.spine * CH + RX]! * -0.8;
    this.hair.v += ((target - this.hair.x) * 90 - this.hair.v * 9) * dt;
    this.hair.x += this.hair.v * dt;
    this.hair.x = Math.max(-0.6, Math.min(0.6, this.hair.x));
    pose[B.hairBack * CH + RX] = this.hair.x;
    pose[B.hairBack * CH + RZ] = 0.08 * Math.sin(this.phase) * (this.weights.walk + this.weights.run) + 0.1 * Math.sin((this.danceT * 112 * TAU) / 120) * this.weights.dance;
  }

  /** Write the pose onto bones (rest + offsets). */
  apply(bones: readonly Bone[], rest: Float32Array) {
    const pose = this.pose;
    for (let b = 0; b < BONE_COUNT; b++) {
      const bone = bones[b]!;
      const i = b * CH;
      bone.rotation.set(pose[i]!, pose[i + 1]!, pose[i + 2]!);
      bone.position.set(rest[b * 3]! + pose[i + 3]!, rest[b * 3 + 1]! + pose[i + 4]!, rest[b * 3 + 2]! + pose[i + 5]!);
      bone.scale.set(1 + pose[i + 6]!, 1 + pose[i + 7]!, 1 + pose[i + 8]!);
    }
  }

  /** Bob value for the NPC marker. */
  get markerBob(): number {
    return Math.sin(this.markerT * 2.2) * 0.04;
  }
  get markerSpin(): number {
    return this.markerT * 1.2;
  }
}
