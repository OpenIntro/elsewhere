/**
 * Island map drawn from shared world data (coastline, creek, paths, decks,
 * buildings, trees, named places). Turned to match the camera so "up" is where
 * you are looking. Hidden things are never marked; The Unknown stays in fog.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILDINGS, CREEK_POINTS, DECKS, FOUNTAIN, LOCATIONS, PATHS, TREES, islandOutline, type Location, type LocationId } from '@elsewhere/shared';
import { useCameraStore, BASE_YAW } from '../../player/camera.js';
import { useGameStore } from '../../state/gameStore.js';
import { runtime } from '../../state/runtime.js';
import { useUiPrefs } from '../localState.js';
import { Icon } from '../icons.js';
import { Sheet, Toggle } from '../primitives.js';

const UNKNOWN = LOCATIONS.find((l) => l.id === 'the_unknown')!;
const deg = (r: number) => (r * 180) / Math.PI;
const pts = (list: readonly { x: number; z: number }[]) => list.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(' ');

/** Short label lines so names sit nicely on the map. */
const LABEL_OFFSET: Partial<Record<LocationId, number>> = { town_square: 7.5, general_store: -5, town_hall: -9, waterfront: 2 };

interface Dot {
  id: string;
  x: number;
  z: number;
  rot: number;
}

function useLivePositions(enabled: boolean): { me: Dot | null; others: Dot[] } {
  const [state, setState] = useState<{ me: Dot | null; others: Dot[] }>({ me: null, others: [] });
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 120) return;
      last = t;
      const lp = runtime.localPlayer;
      const me = lp.ready ? { id: 'me', x: lp.x, z: lp.z, rot: lp.rot } : null;
      const others: Dot[] = [];
      if (enabled) {
        runtime.remotes.forEach((r, id) => {
          const p = r.render?.visible ? r.render : r.buffer[r.buffer.length - 1];
          if (p) others.push({ id, x: p.x, z: p.z, rot: p.rot });
        });
      }
      setState({ me, others });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
  return state;
}

export function MapPanel({ onClose }: { onClose(): void }) {
  const rotation = useCameraStore((s) => s.rotation);
  const yaw = BASE_YAW + (rotation * Math.PI) / 2;
  const showOthers = useUiPrefs((s) => s.mapShowOthers);
  const setPrefs = useUiPrefs((s) => s.set);
  const players = useGameStore((s) => s.players);
  const myLocation = useGameStore((s) => (s.sessionId ? s.players[s.sessionId]?.location : ''));
  const { me, others } = useLivePositions(showOthers);
  const [selected, setSelected] = useState<Location | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const outline = useMemo(() => islandOutline(180), []);
  const trees = useMemo(() => TREES.filter((t) => Math.hypot(t.position.x - UNKNOWN.center.x, t.position.z - UNKNOWN.center.z) > UNKNOWN.radius + 6), []);

  // ViewBox that fits the rotated island.
  const view = useMemo(() => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of outline) {
      const x = p.x * c - p.z * s;
      const y = p.x * s + p.z * c;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const pad = 9;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }, [outline, yaw]);

  const rot = deg(yaw);
  const counter = `rotate(${-rot})`;
  const othersCount = Object.values(players).filter((p) => !p.isLocal).length;
  const here = LOCATIONS.find((l) => l.id === myLocation);

  return (
    <Sheet title="The Commons" eyebrow="Map" icon="map" size="wide" onClose={onClose} testId="panel-map" className="sheet--map">
      <div className="map">
        <svg ref={svgRef} className="map__svg" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} role="img" aria-label={`Map of the island${here ? `. You are at ${here.name}` : ''}`}>
          <defs>
            <radialGradient id="map-fog">
              <stop offset="0" stopColor="#c9c2d6" stopOpacity="0.55" />
              <stop offset="0.6" stopColor="#a49cb6" stopOpacity="0.35" />
              <stop offset="1" stopColor="#a49cb6" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="map-sea" cx="0.5" cy="0.5" r="0.7">
              <stop offset="0" stopColor="#7fa3a6" stopOpacity="0.35" />
              <stop offset="1" stopColor="#7fa3a6" stopOpacity="0" />
            </radialGradient>
            <filter id="map-soft" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2.2" />
            </filter>
          </defs>
          <g transform={`rotate(${rot})`}>
            <circle cx="0" cy="0" r="95" fill="url(#map-sea)" />
            <polygon points={pts(outline)} className="map__shore" />
            <polygon points={pts(outline)} className="map__land" />
            <polyline points={pts(CREEK_POINTS)} className="map__creek" />
            {trees.map((t, i) => (
              <circle key={i} cx={t.position.x} cy={t.position.z} r={0.9 * (t.scale ?? 1)} className="map__tree" />
            ))}
            {PATHS.map((p) => (
              <polyline key={p.id} points={pts(p.points)} className={`map__path map__path--${p.surface}`} style={{ strokeWidth: Math.max(1.2, p.width * 0.75) }} />
            ))}
            {DECKS.map((d) => (
              <rect key={d.id} x={-d.halfWidth} y={-d.halfLength} width={d.halfWidth * 2} height={d.halfLength * 2} transform={`translate(${d.center.x} ${d.center.z}) rotate(${-deg(d.yaw)})`} className="map__deck" />
            ))}
            {BUILDINGS.map((b) => (
              <rect
                key={b.id}
                x={-b.width / 2}
                y={-b.depth / 2}
                width={b.width}
                height={b.depth}
                rx={0.8}
                transform={`translate(${b.position.x} ${b.position.z}) rotate(${-deg(b.yaw)})`}
                className="map__building"
                style={{ fill: b.roofColor }}
              />
            ))}
            <circle cx={FOUNTAIN.position.x} cy={FOUNTAIN.position.z} r={FOUNTAIN.basinRadius} className="map__fountain" />
            {/* The Unknown: fog, no detail. */}
            <circle cx={UNKNOWN.center.x} cy={UNKNOWN.center.z} r={UNKNOWN.radius + 9} fill="url(#map-fog)" filter="url(#map-soft)" className="map__fog" />
            <circle cx={UNKNOWN.center.x} cy={UNKNOWN.center.z} r={UNKNOWN.radius - 2} className="map__unknown-ring" />

            {showOthers
              ? others.map((o) => (
                  <circle key={o.id} cx={o.x} cy={o.z} r={1.5} className="map__other">
                    <title>{players[o.id]?.name ?? 'Someone'}</title>
                  </circle>
                ))
              : null}
            {me ? (
              <g transform={`translate(${me.x} ${me.z})`} className="map__me">
                <circle r="5.5" className="map__me-halo" />
                <g transform={`rotate(${-deg(me.rot)})`}>
                  <path d="M0 4.6 L-2.4 -1.6 L0 -0.6 L2.4 -1.6 Z" className="map__me-arrow" />
                </g>
              </g>
            ) : null}

            {LOCATIONS.map((l) => {
              const unknown = l.id === 'the_unknown';
              const dy = LABEL_OFFSET[l.id] ?? 0;
              return (
                <g key={l.id} transform={`translate(${l.center.x} ${l.center.z})`}>
                  <g transform={`${counter} translate(0 ${dy})`}>
                    <text className={`map__label${unknown ? ' map__label--unknown' : ''}${l.id === myLocation ? ' is-here' : ''}`} textAnchor="middle" dominantBaseline="middle">
                      {l.name}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
          {/* Compass (screen space, top-right of the drawing). */}
          <g transform={`translate(${view.x + view.w - 10} ${view.y + 10})`} className="map__compass" aria-hidden="true">
            <circle r="6.5" />
            <g transform={`rotate(${rot})`}>
              <path d="M0 -5.2 L1.7 0 L0 -1 L-1.7 0 Z" className="map__compass-n" />
              <text y="-7.6" textAnchor="middle" transform="">
                N
              </text>
            </g>
          </g>
        </svg>

        <div className="map__places" role="list" aria-label="Places">
          {LOCATIONS.map((l) => (
            <button key={l.id} type="button" role="listitem" className={`place-chip${selected?.id === l.id ? ' is-on' : ''}${l.id === myLocation ? ' is-here' : ''}${l.id === 'the_unknown' ? ' is-unknown' : ''}`} onClick={() => setSelected(selected?.id === l.id ? null : l)}>
              {l.id === myLocation ? <Icon name="pin" size={14} /> : null}
              {l.name}
            </button>
          ))}
        </div>
        <p className="map__caption" aria-live="polite">
          {selected ? (
            <>
              <strong>{selected.name}.</strong> {selected.id === 'the_unknown' ? 'Few go there. Fewer say what they found.' : selected.description}
            </>
          ) : here ? (
            <>
              You are at <strong>{here.name}</strong>.
            </>
          ) : (
            'You are somewhere in between.'
          )}
        </p>
        <div className="map__foot">
          <Toggle label="Show other people" hint={othersCount ? `${othersCount} in this world now` : 'No one else is here right now'} checked={showOthers} onChange={(v) => setPrefs({ mapShowOthers: v })} />
        </div>
      </div>
    </Sheet>
  );
}
