/**
 * In-world DOM overlay anchored to characters: name labels, speech bubbles,
 * typing indicators and floating reactions. Mounted inside the Canvas; it
 * owns one absolutely positioned container next to the canvas and updates
 * pooled elements imperatively each frame (no React per frame, transforms
 * only written when they change).
 *
 * Restraint rules (never visually overwhelming):
 *  - Labels: real players only beyond yourself, within a zoom-dependent
 *    range, faded by distance, scaled by zoom, at most MAX_LABELS, and a
 *    label that would overlap a nearer one is hidden (speakers excepted).
 *  - Bubbles: one per speaker (newest replaces), ≤ MAX_BUBBLES at once
 *    (nearest first), within chat range; overlapping ones collapse to a
 *    single compact line; auto-fade after a length-based duration.
 *  - Reactions: ≤ 3 per player, ≤ 24 total, rise + fade.
 *
 * Label convention: `.ew-label[data-kind="player"]` (solid pill with a dot in
 * the player's shirt colour) vs `[data-kind="npc"]` (italic, no dot, leaf
 * glyph, dashed edge, a small "keeper" badge) — the building keepers (client/src/activities)
 * register via `registerOverlayActor()`; they are world characters, never players.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3 } from 'three';
import { CLOTHING_COLORS, CONFIG, colorHex } from '@elsewhere/shared';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { useSettingsStore } from '../state/settingsStore.js';
import { ZOOM_DEFAULT, cameraRuntime } from '../player/camera.js';
import { isHiddenIndoors } from '../world/cutawayRuntime.js';
import { devOverrides } from '../world/env.js';
import { perfAdd, perfFrame } from './perf.js';
import { REACTION_MS, bubbles, installSocialFeed, pruneSocial, reactions } from './social.js';

const MAX_LABELS = 18;
const MAX_BUBBLES = 6;
const BUBBLE_RANGE = CONFIG.chat.proximityRadius + 4;
const HEAD = 2.05;
const SEATED_HEAD = 1.6;
const FADE_MS = 260;

export type ActorKind = 'self' | 'player' | 'npc';

export interface OverlayActorSource {
  kind: 'npc';
  name: string;
  /** Write the actor's ground position into `out`; return false when absent. */
  pose(out: { x: number; y: number; z: number }): boolean;
}

const npcSources = new Map<string, OverlayActorSource>();
/** Future NPCs: register a labelled actor (rendered with the NPC label style). Returns unregister. */
export function registerOverlayActor(id: string, src: OverlayActorSource): () => void {
  npcSources.set(`npc:${id}`, src);
  return () => npcSources.delete(`npc:${id}`);
}

interface ActorDom {
  id: string;
  kind: ActorKind;
  root: HTMLDivElement;
  label: HTMLDivElement;
  dot: HTMLSpanElement;
  nameEl: HTMLSpanElement;
  bubble: HTMLDivElement;
  name: string;
  color: string;
  labelW: number;
  labelH: number;
  bubbleId: string;
  bubbleW: number;
  bubbleH: number;
  // per frame
  sx: number;
  sy: number;
  dist: number;
  alpha: number;
  seen: number;
  lastTransform: string;
  lastOpacity: number;
  labelOn: boolean;
  bubbleOn: boolean;
  bubbleCompact: boolean;
  typingOn: boolean;
  speaking: boolean;
  typing: boolean;
  onScreen: boolean;
}

const CSS = `
.ew-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;contain:strict;font:13px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif}
.ew-actor{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;gap:4px;will-change:transform,opacity;transform-origin:50% 100%}
.ew-label{display:flex;align-items:center;gap:5px;padding:2px 8px 2px 6px;border-radius:999px;background:rgba(36,32,29,.62);color:#f4ead6;font-weight:600;font-size:12px;letter-spacing:.01em;white-space:nowrap;text-shadow:0 1px 1px rgba(0,0,0,.35);transition:opacity .2s}
.ew-label .ew-dot{width:7px;height:7px;border-radius:50%;box-shadow:0 0 0 1.5px rgba(244,234,214,.55)}
.ew-label[data-kind="npc"]{background:rgba(54,48,36,.5);color:#f1dfae;font-style:italic;font-weight:500;border:1px dashed rgba(241,223,174,.45);padding-left:8px}
.ew-label[data-kind="npc"] .ew-dot{display:none}
.ew-label[data-kind="npc"]::before{content:"❦";font-style:normal;opacity:.8}
.ew-label[data-kind="npc"]::after{content:"keeper";font-style:normal;font-weight:700;font-size:8.5px;letter-spacing:.09em;text-transform:uppercase;line-height:1;padding:2px 5px 2px;border-radius:5px;background:rgba(241,223,174,.2);color:#f6e7bf;margin-left:2px}
.ew-label.ew-off{opacity:0}
.ew-bubble{max-width:200px;padding:6px 10px;border-radius:12px;background:rgba(253,248,238,.95);color:#2b2621;font-size:13px;line-height:1.3;box-shadow:0 2px 8px rgba(0,0,0,.16);position:relative;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;transition:opacity .25s}
.ew-bubble::after{content:"";position:absolute;left:50%;bottom:-5px;margin-left:-5px;border:5px solid transparent;border-bottom:0;border-top-color:rgba(253,248,238,.95)}
.ew-bubble.ew-compact{-webkit-line-clamp:1;max-width:130px;font-size:12px;padding:4px 8px;opacity:.85}
.ew-bubble.ew-typing{padding:3px 9px;font-weight:700;letter-spacing:2px;color:#6d6257}
.ew-bubble.ew-off{display:none}
.ew-reaction{position:absolute;left:0;top:0;font-size:22px;line-height:1;will-change:transform,opacity;filter:drop-shadow(0 1px 2px rgba(0,0,0,.25))}
`;

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const s = document.createElement('style');
  s.dataset.owner = 'elsewhere-overlay';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function makeActor(id: string, kind: ActorKind, container: HTMLElement): ActorDom {
  const root = document.createElement('div');
  root.className = 'ew-actor';
  root.style.opacity = '0';
  const bubble = document.createElement('div');
  bubble.className = 'ew-bubble ew-off';
  const label = document.createElement('div');
  label.className = 'ew-label ew-off';
  label.dataset.kind = kind === 'npc' ? 'npc' : 'player';
  const dot = document.createElement('span');
  dot.className = 'ew-dot';
  const nameEl = document.createElement('span');
  label.append(dot, nameEl);
  root.append(bubble, label);
  root.dataset.actor = id;
  container.appendChild(root);
  return {
    id,
    kind,
    root,
    label,
    dot,
    nameEl,
    bubble,
    name: '',
    color: '',
    labelW: 60,
    labelH: 20,
    bubbleId: '',
    bubbleW: 0,
    bubbleH: 0,
    sx: 0,
    sy: 0,
    dist: 0,
    alpha: 0,
    seen: 0,
    lastTransform: '',
    lastOpacity: -1,
    labelOn: false,
    bubbleOn: false,
    bubbleCompact: false,
    typingOn: false,
    speaking: false,
    typing: false,
    onScreen: false,
  };
}

/** Axis-aligned rects placed this frame (x0, y0, x1, y1). */
const placed = new Float32Array(4 * 128);

function overlaps(n: number, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (x0 < placed[o + 2]! && x1 > placed[o]! && y0 < placed[o + 3]! && y1 > placed[o + 1]!) {
      // Ignore slivers (< 35% of the smaller height).
      const oy = Math.min(y1, placed[o + 3]!) - Math.max(y0, placed[o + 1]!);
      if (oy > 0.35 * Math.min(y1 - y0, placed[o + 3]! - placed[o + 1]!)) return true;
    }
  }
  return false;
}

export function WorldOverlay() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const ref = useRef<{
    container: HTMLDivElement | null;
    actors: Map<string, ActorDom>;
    order: ActorDom[];
    reactionEls: HTMLSpanElement[];
    frame: number;
    lastPrune: number;
  }>({
    container: null,
    actors: new Map(),
    order: [],
    reactionEls: [],
    frame: 0,
    lastPrune: 0,
  });
  const v = useRef(new Vector3());
  const pos = useRef({ x: 0, y: 0, z: 0 });

  useEffect(() => {
    injectStyle();
    const parent = gl.domElement.parentElement ?? document.body;
    const container = document.createElement('div');
    container.className = 'ew-overlay';
    container.dataset.testid = 'world-overlay';
    parent.appendChild(container);
    const st = ref.current;
    st.container = container;
    st.reactionEls = [];
    const offFeed = installSocialFeed();
    return () => {
      offFeed();
      container.remove();
      st.container = null;
      st.actors.clear();
      st.order.length = 0;
      st.reactionEls = [];
    };
  }, [gl]);

  useFrame(() => {
    perfFrame();
    const t0 = performance.now();
    try {
      overlayFrame();
    } finally {
      perfAdd('overlay', performance.now() - t0);
    }
  });

  function overlayFrame(): void {
    const st = ref.current;
    const container = st.container;
    if (!container) return;
    const now = performance.now();
    const frame = ++st.frame;
    if (now - st.lastPrune > 250) {
      st.lastPrune = now;
      pruneSocial(now);
    }
    const W = gl.domElement.clientWidth;
    const H = gl.domElement.clientHeight;
    const game = useGameStore.getState();
    const showNames = useSettingsStore.getState().controls.showNames;
    const lp = runtime.localPlayer;
    const view = runtime.view;
    // Dev camera override (?cam=, screenshots): distances are measured from what is on screen.
    const dev = devOverrides.cam;
    const refX = dev ? dev.x : view.free ? view.focusX : lp.x;
    const refZ = dev ? dev.z : view.free ? view.focusZ : lp.z;
    // Label size follows the user's zoom relative to the default framing (not the viewport scale).
    const rel = cameraRuntime.zoom / ZOOM_DEFAULT;
    const scale = Math.min(1.08, Math.max(0.72, 0.55 + rel * 0.45));
    const farOut = rel < 0.5;
    const nameRange = farOut ? 10 : Math.min(34, Math.max(12, view.halfWidth * 0.95));
    const vec = v.current;
    const order = st.order;
    order.length = 0;

    const project = (a: ActorDom, x: number, y: number, z: number, seated: boolean) => {
      vec.set(x, y + (seated ? SEATED_HEAD : HEAD), z).project(camera);
      a.sx = ((vec.x + 1) / 2) * W;
      a.sy = ((1 - vec.y) / 2) * H;
      a.onScreen = vec.z < 1 && a.sx > -80 && a.sx < W + 80 && a.sy > -60 && a.sy < H + 140;
      a.dist = Math.hypot(x - refX, z - refZ);
      a.seen = frame;
      if (a.onScreen) order.push(a);
    };

    const ensure = (id: string, kind: ActorKind): ActorDom => {
      let a = st.actors.get(id);
      if (!a) {
        a = makeActor(id, kind, container);
        st.actors.set(id, a);
      }
      return a;
    };

    const setName = (a: ActorDom, name: string, color: string) => {
      if (a.name !== name) {
        a.name = name;
        a.nameEl.textContent = name;
        a.labelW = a.label.offsetWidth || name.length * 7 + 22;
        a.labelH = a.label.offsetHeight || 20;
      }
      if (a.color !== color) {
        a.color = color;
        a.dot.style.background = color;
      }
    };

    // Local player (bubbles / typing only — no own name label).
    const sid = game.sessionId;
    if (lp.ready && sid) {
      const me = game.players[sid];
      const a = ensure(sid, 'self');
      a.typing = !!me?.typing;
      project(a, lp.x, lp.y, lp.z, !!me?.seat);
    }
    // Remotes.
    for (const [id, r] of runtime.remotes) {
      const p = r.render;
      if (!p || !p.visible || id === sid) continue;
      // Inside a building whose roof is closed for this viewer: hidden by the roof, so no tag/bubble either.
      if (isHiddenIndoors(p.x, p.z)) continue;
      const info = game.players[id];
      if (!info) continue;
      const a = ensure(id, 'player');
      setName(a, info.name, colorHex(CLOTHING_COLORS, info.appearance.shirtColor));
      a.typing = info.typing;
      project(a, p.x, p.y, p.z, !!info.seat || info.anim === 'sit');
    }
    // NPCs (future).
    for (const [id, src] of npcSources) {
      if (!src.pose(pos.current)) continue;
      const a = ensure(id, 'npc');
      setName(a, src.name, '');
      a.typing = false;
      project(a, pos.current.x, pos.current.y, pos.current.z, false);
    }

    // Priority: nearest first, speakers slightly ahead.
    for (const a of order) a.speaking = bubbles.has(a.id);
    order.sort((a, b) => a.dist - (a.speaking ? 4 : 0) - (b.dist - (b.speaking ? 4 : 0)));

    let nPlaced = 0;
    let labels = 0;
    let shownBubbles = 0;
    for (const a of order) {
      const b = bubbles.get(a.id);
      // Bubble
      let bubbleOn = false;
      let compact = false;
      let bubbleAlpha = 1;
      if (b && a.dist < BUBBLE_RANGE && shownBubbles < MAX_BUBBLES) {
        if (a.bubbleId !== b.id || a.bubble.textContent !== b.text) {
          a.bubbleId = b.id;
          a.bubble.textContent = b.text;
          a.bubble.classList.remove('ew-off', 'ew-typing', 'ew-compact');
          a.bubbleCompact = false;
          a.bubbleW = a.bubble.offsetWidth || 160;
          a.bubbleH = a.bubble.offsetHeight || 40;
          a.typingOn = false;
        }
        bubbleOn = true;
        const left = b.until - now;
        bubbleAlpha = Math.min(1, left / 600, (now - b.at) / 150);
        const bx0 = a.sx - (a.bubbleW * scale) / 2;
        const by1 = a.sy - a.labelH * scale - 4;
        compact = overlaps(nPlaced, bx0, by1 - a.bubbleH * scale, bx0 + a.bubbleW * scale, by1);
        shownBubbles++;
      } else if (a.typing && !b && a.dist < BUBBLE_RANGE) {
        if (!a.typingOn) {
          a.typingOn = true;
          a.bubbleId = '';
          a.bubble.textContent = '•••';
          a.bubble.classList.remove('ew-off', 'ew-compact');
          a.bubble.classList.add('ew-typing');
          a.bubbleW = 40;
          a.bubbleH = 22;
        }
        bubbleOn = true;
      }
      if (!bubbleOn && (a.bubbleOn || a.typingOn)) {
        a.bubble.classList.add('ew-off');
        a.bubble.classList.remove('ew-typing');
        a.typingOn = false;
        a.bubbleId = '';
      }
      if (bubbleOn && !a.typingOn && compact !== a.bubbleCompact) {
        a.bubbleCompact = compact;
        a.bubble.classList.toggle('ew-compact', compact);
      }
      a.bubbleOn = bubbleOn;
      if (bubbleOn) a.bubble.style.opacity = bubbleAlpha < 0.999 ? bubbleAlpha.toFixed(2) : '';

      // Label
      let labelOn = false;
      if (a.kind !== 'self' && showNames && labels < MAX_LABELS && (a.dist < nameRange || a.speaking)) {
        const w = a.labelW * scale;
        const h = a.labelH * scale;
        const x0 = a.sx - w / 2;
        const y0 = a.sy - h;
        if (a.speaking || !overlaps(nPlaced, x0, y0, x0 + w, a.sy)) {
          labelOn = true;
          labels++;
          if (nPlaced < 128) {
            const o = nPlaced++ * 4;
            placed[o] = x0;
            placed[o + 1] = y0;
            placed[o + 2] = x0 + w;
            placed[o + 3] = a.sy;
          }
        }
      }
      if (bubbleOn && nPlaced < 128) {
        const bw = (a.bubbleCompact ? Math.min(a.bubbleW, 130) : a.bubbleW) * scale;
        const bh = (a.bubbleCompact ? 22 : a.bubbleH) * scale;
        const by1 = a.sy - (labelOn ? a.labelH * scale + 4 : 0);
        const o = nPlaced++ * 4;
        placed[o] = a.sx - bw / 2;
        placed[o + 1] = by1 - bh;
        placed[o + 2] = a.sx + bw / 2;
        placed[o + 3] = by1;
      }
      if (labelOn !== a.labelOn) {
        a.labelOn = labelOn;
        a.label.classList.toggle('ew-off', !labelOn);
      }
      // Distance fade for labels; whole actor fades in/out.
      const distFade = a.kind === 'self' ? 1 : Math.min(1, Math.max(0.25, (nameRange + 4 - a.dist) / 6));
      const visible = labelOn || bubbleOn;
      a.alpha += ((visible ? distFade : 0) - a.alpha) * 0.25;
      const op = Math.round(a.alpha * 100) / 100;
      if (op !== a.lastOpacity) {
        a.lastOpacity = op;
        a.root.style.opacity = String(op);
      }
      const t = `translate3d(${Math.round(a.sx)}px,${Math.round(a.sy)}px,0) translate(-50%,-100%) scale(${scale.toFixed(2)})`;
      if (t !== a.lastTransform) {
        a.lastTransform = t;
        a.root.style.transform = t;
      }
    }

    // Actors not seen this frame (left / off-screen): fade out, then drop.
    for (const [id, a] of st.actors) {
      if (a.seen === frame && a.onScreen) continue;
      a.alpha *= Math.exp((-16.7 / FADE_MS) * 3);
      const op = Math.round(a.alpha * 100) / 100;
      if (op !== a.lastOpacity) {
        a.lastOpacity = op;
        a.root.style.opacity = String(op);
      }
      if (a.seen !== frame && a.alpha < 0.02) {
        a.root.remove();
        st.actors.delete(id);
      }
    }

    // Reactions (pooled spans).
    const els = st.reactionEls;
    let used = 0;
    for (const r of reactions) {
      const a = st.actors.get(r.sessionId);
      if (!a || a.seen !== frame || !a.onScreen) continue;
      let el = els[used];
      if (!el) {
        el = document.createElement('span');
        el.className = 'ew-reaction';
        container.appendChild(el);
        els[used] = el;
      }
      used++;
      if (el.textContent !== r.emoji) el.textContent = r.emoji;
      const age = (now - r.at) / REACTION_MS;
      const rise = 18 + 46 * (1 - Math.pow(1 - age, 2));
      const lift = (a.bubbleOn ? a.bubbleH * scale + 6 : 0) + (a.labelOn ? a.labelH * scale : 0);
      const x = a.sx - 11 + (r.lane - 1) * 20 * scale;
      const y = a.sy - lift - rise - 22;
      el.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0) scale(${(scale * (age < 0.12 ? 0.6 + age * 3.3 : 1)).toFixed(2)})`;
      el.style.opacity = (age < 0.7 ? 1 : Math.max(0, (1 - age) / 0.3)).toFixed(2);
      el.style.display = '';
    }
    for (let i = used; i < els.length; i++) if (els[i]!.style.display !== 'none') els[i]!.style.display = 'none';
  }

  return null;
}
