/**
 * Hand-painted sign faces in one canvas atlas (single material for every
 * sign in the world). Each label gets a cell; geometry maps its UVs to it.
 */
import { CanvasTexture, LinearMipmapLinearFilter, MeshStandardMaterial, SRGBColorSpace } from 'three';
import { patch } from './materials.js';

export interface SignLabel {
  key: string;
  text: string;
  sub?: string;
  bg: string;
  fg: string;
  /** 'serif' (painted), 'script' (café), 'block' (shop), 'chalk' (menu board). */
  style?: 'serif' | 'script' | 'block' | 'chalk' | 'paper' | 'rune';
}

const COLS = 4;
const ROWS = 8;
const CW = 512;
const CH = 128;

export const SIGN_LABELS: SignLabel[] = [
  { key: 'cafe', text: 'Café', sub: 'est. long ago', bg: '#2f4a44', fg: '#f3e4c4', style: 'script' },
  { key: 'store', text: 'GENERAL STORE', sub: 'goods · post · sundries', bg: '#e9dcc0', fg: '#4a5a46', style: 'block' },
  { key: 'hall', text: 'TOWN HALL', bg: '#d9cfbd', fg: '#5a4c5c', style: 'serif' },
  { key: 'workshop', text: 'WORKSHOP', sub: 'repairs & wonders', bg: '#4b3a2e', fg: '#e8c98f', style: 'block' },
  { key: 'boathouse', text: 'BOATHOUSE', bg: '#e6e0d0', fg: '#3f4e57', style: 'serif' },
  { key: 'gazette', text: 'The Gazette', bg: '#7a3f36', fg: '#f6ead2', style: 'script' },
  { key: 'welcome', text: 'The Commons', sub: 'welcome, wanderer', bg: '#7b5a40', fg: '#f4e5c6', style: 'serif' },
  { key: 'notice', text: 'NOTICES', bg: '#c9a87c', fg: '#4a3626', style: 'block' },
  { key: 'menu', text: 'Today', sub: 'coffee · tea · buns', bg: '#2e3431', fg: '#eeeae0', style: 'chalk' },
  { key: 'store_hours', text: 'Open when', sub: 'the door is open', bg: '#e8dcc2', fg: '#5a4636', style: 'serif' },
  { key: 'hall_sign', text: 'Town Hall', sub: 'ring the bell, anyone', bg: '#5f5367', fg: '#efe6d2', style: 'serif' },
  { key: 'workshop_sign', text: 'Borrow a tool', sub: 'return a tool', bg: '#7b5a40', fg: '#f4e5c6', style: 'serif' },
  { key: 'residential', text: 'Garden Lane', sub: 'please close the gates', bg: '#5f7c64', fg: '#f1ead6', style: 'serif' },
  { key: 'woods', text: 'The Woods', sub: '← Fern Loop · Stone Trail →', bg: '#6b5440', fg: '#ecdcb8', style: 'serif' },
  { key: 'unknown', text: 'Beyond This Point', sub: 'the unknown', bg: '#8a8578', fg: '#2f2c28', style: 'rune' },
  { key: 'dock', text: 'The Dock', sub: 'sunsets nightly', bg: '#3f4e57', fg: '#f0e8d6', style: 'serif' },
  { key: 'paper1', text: 'LOST: wrench', sub: 'ask at the Workshop', bg: '#f3ecd9', fg: '#4a4038', style: 'paper' },
  { key: 'paper2', text: 'Bell practice', sub: 'any hour', bg: '#efe2c9', fg: '#5a3d36', style: 'paper' },
  { key: 'house1', text: 'No. 1', bg: '#f1e6d1', fg: '#6b4a3a', style: 'serif' },
  { key: 'house2', text: 'No. 2', bg: '#f1e6d1', fg: '#3f5a52', style: 'serif' },
  { key: 'house3', text: 'No. 3', bg: '#f1e6d1', fg: '#6b5236', style: 'serif' },
  { key: 'house4', text: 'No. 4', bg: '#f1e6d1', fg: '#5a4458', style: 'serif' },
  { key: 'house5', text: 'No. 5', bg: '#f1e6d1', fg: '#3e4f60', style: 'serif' },
  { key: 'future_home', text: 'a future home', sub: 'waiting for someone', bg: '#f1e6d1', fg: '#6b4a3a', style: 'script' },
  { key: 'inscription', text: 'ᚠ ᛟ ᚱ ᛗ ᛁ ᚾ ᛞ', sub: 'all who pass are remembered', bg: '#8c877b', fg: '#e8f4ee', style: 'rune' },
];

const INDEX = new Map(SIGN_LABELS.map((l, i) => [l.key, i]));

export function signUV(key: string): [number, number, number, number] {
  const i = INDEX.get(key) ?? 0;
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const u0 = col / COLS;
  const u1 = (col + 1) / COLS;
  const v1 = 1 - row / ROWS;
  const v0 = 1 - (row + 1) / ROWS;
  const pad = 0.002;
  return [u0 + pad, v0 + pad, u1 - pad, v1 - pad];
}

/** Aspect (w/h) of a sign cell. */
export const SIGN_ASPECT = CW / CH;

function drawLabel(g: CanvasRenderingContext2D, l: SignLabel, x: number, y: number): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = l.bg;
  g.fillRect(0, 0, CW, CH);
  // painted texture: streaks
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${i % 2 ? '255,255,255' : '0,0,0'},${0.02 + (i % 5) * 0.006})`;
    g.fillRect(0, (i * 37) % CH, CW, 2 + (i % 3));
  }
  if (l.style !== 'paper') {
    g.strokeStyle = l.fg;
    g.globalAlpha = 0.55;
    g.lineWidth = 5;
    g.strokeRect(12, 10, CW - 24, CH - 20);
    g.globalAlpha = 1;
  }
  g.fillStyle = l.fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const fam =
    l.style === 'script' ? 'italic 600 {s}px Georgia, "Times New Roman", serif'
      : l.style === 'block' ? '800 {s}px "Trebuchet MS", Verdana, sans-serif'
        : l.style === 'chalk' ? 'italic 700 {s}px "Comic Sans MS", "Trebuchet MS", sans-serif'
          : l.style === 'paper' ? '700 {s}px "Courier New", monospace'
            : '700 {s}px Georgia, "Times New Roman", serif';
  const main = l.sub ? 54 : 66;
  let size = main;
  g.font = fam.replace('{s}', String(size));
  while (g.measureText(l.text).width > CW - 60 && size > 20) {
    size -= 2;
    g.font = fam.replace('{s}', String(size));
  }
  if (l.style === 'chalk') g.globalAlpha = 0.9;
  g.fillText(l.text, CW / 2, l.sub ? CH * 0.4 : CH / 2 + 3);
  if (l.sub) {
    let s2 = 26;
    g.font = fam.replace('{s}', String(s2)).replace('800', '600');
    while (g.measureText(l.sub).width > CW - 60 && s2 > 12) {
      s2 -= 1;
      g.font = fam.replace('{s}', String(s2));
    }
    g.globalAlpha = 0.85;
    g.fillText(l.sub, CW / 2, CH * 0.76);
  }
  g.restore();
}

let material: MeshStandardMaterial | null = null;
export function signMaterial(): MeshStandardMaterial {
  if (material) return material;
  const c = document.createElement('canvas');
  c.width = CW * COLS;
  c.height = CH * ROWS;
  const g = c.getContext('2d')!;
  SIGN_LABELS.forEach((l, i) => drawLabel(g, l, (i % COLS) * CW, Math.floor(i / COLS) * CH));
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = LinearMipmapLinearFilter;
  material = patch(new MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 }), { paint: 0.5 });
  return material;
}

let cutMaterial: MeshStandardMaterial | null = null;
/** Same atlas, cutaway-aware (signs on walk-in buildings fade with their wall). */
export function signCutMaterial(): MeshStandardMaterial {
  if (cutMaterial) return cutMaterial;
  const base = signMaterial();
  cutMaterial = patch(new MeshStandardMaterial({ map: base.map, roughness: 0.85, metalness: 0 }), { paint: 0.5, cut: true });
  return cutMaterial;
}
