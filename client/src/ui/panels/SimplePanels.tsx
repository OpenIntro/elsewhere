/** Inventory (real held item + collection + discoveries) and the Home panel (your home, or how to make one, + planned cards). */
import { DISCOVERIES, ITEMS, locationAt, type ItemId } from '@elsewhere/shared';
import { homeActions, useHomesStore } from '../../build/homes.js';
import { actions } from '../../net/index.js';
import { useGameStore } from '../../state/gameStore.js';
import { Icon, ItemGlyph } from '../icons.js';
import { Empty, Sheet, Toggle } from '../primitives.js';

export function InventoryPanel({ onClose }: { onClose(): void }) {
  const held = useGameStore((s) => (s.sessionId ? s.players[s.sessionId]?.held : '') ?? '');
  const profile = useGameStore((s) => s.profile);
  const collection = (profile?.inventory ?? []).filter((id): id is ItemId => id in ITEMS);
  const discoveries = (profile?.discoveries ?? []).filter((id) => id in DISCOVERIES);
  const heldDef = held ? ITEMS[held] : null;

  return (
    <Sheet title="Your things" eyebrow="Inventory" icon="bag" onClose={onClose} testId="panel-inventory">
      <section className="section">
        <h3 className="section__title">In hand</h3>
        {heldDef ? (
          <div className="item item--held">
            <span className="item__glyph">
              <ItemGlyph item={heldDef} size={44} />
            </span>
            <div className="item__text">
              <strong>{heldDef.name}</strong>
              <span>{heldDef.description}</span>
            </div>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => actions.dropItem()}>
              <Icon name="drop" size={16} /> Set down
            </button>
          </div>
        ) : (
          <Empty icon="bag" title="Your hands are empty">
            You can carry one thing at a time. Look around — some things can be picked up.
          </Empty>
        )}
      </section>

      {collection.length ? (
        <section className="section">
          <h3 className="section__title">Things you’ve held</h3>
          <ul className="item-grid">
            {collection.map((id) => (
              <li key={id} className="item-tile" title={ITEMS[id].description}>
                <ItemGlyph item={ITEMS[id]} size={34} />
                <span>{ITEMS[id].name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section">
        <h3 className="section__title">Discoveries</h3>
        {discoveries.length ? (
          <ul className="discoveries">
            {discoveries.map((id) => (
              <li key={id} className="discovery">
                <Icon name="sparkle" size={18} />
                <div>
                  <strong>{DISCOVERIES[id].name}</strong>
                  <span>{DISCOVERIES[id].text}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing yet. The island keeps a few secrets.</p>
        )}
      </section>
    </Sheet>
  );
}

/** Still planned (the working home feature replaced the "A home of your own" card). */
const FUTURE = [
  { title: 'Letters', text: 'A letterbox by your door for letters addressed to you.' },
  { title: 'Building with friends', text: 'Invite someone to help build your home with you.' },
  { title: 'Decorating', text: 'Furniture, plants and the odd mysterious object, arranged just so.' },
  { title: 'Shops & trading', text: 'Swap things with neighbours; the General Store finally opens its till.' },
  { title: 'A gentle currency', text: 'Earned by being around, never bought.' },
];

function HouseArt({ dashed }: { dashed: boolean }) {
  const dash = dashed ? '3 3.5' : undefined;
  return (
    <svg className="notyet__art" viewBox="0 0 120 80" aria-hidden="true">
      <path d="M10 70h100" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M34 70V42l26-20 26 20v28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeDasharray={dash} />
      <path d="M54 70V54h12v16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={dash} />
      {dashed ? null : <rect x="70" y="48" width="8" height="8" rx="1" fill="var(--accent)" opacity=".7" />}
      <circle cx="92" cy="20" r="6" fill="var(--accent)" opacity=".75" />
      <path d="M18 70c0-8 4-12 8-12s6 4 6 12" fill="none" stroke="var(--sage)" strokeWidth="1.6" />
    </svg>
  );
}

function Planned() {
  return (
    <section className="section">
      <h3 className="section__title">Still to come</h3>
      <ul className="future" data-testid="home-planned">
        {FUTURE.map((f) => (
          <li key={f.title}>
            <span className="tag">Planned</span>
            <strong>{f.title}</strong>
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">The cards marked Planned don’t work yet — we’d rather say so than pretend.</p>
    </section>
  );
}

export function HomePanel({ onClose }: { onClose(): void }) {
  const me = useGameStore((s) => s.profile?.profileId);
  const home = useHomesStore((s) => (me ? s.homes[me] : undefined));
  const result = useHomesStore((s) => s.result);
  const pending = useHomesStore((s) => s.pending > 0);
  const recent = result && Date.now() - result.at < 8000 && result.action !== 'set' ? result : null;
  const place = home ? locationAt({ x: (home.rect.minX + home.rect.maxX) / 2, z: (home.rect.minZ + home.rect.maxZ) / 2 }) : null;
  return (
    <Sheet title="Home" eyebrow={home ? 'Your home' : 'Make a home'} icon="home" onClose={onClose} testId="panel-home">
      <div className="notyet" data-testid="home-panel" data-has-home={home ? 'yes' : 'no'}>
        <HouseArt dashed={!home} />
        {home ? (
          <>
            <p className="notyet__lede" data-testid="home-name">
              {home.name || 'Your house'}
            </p>
            <p className="muted small" style={{ margin: 0, textAlign: 'center' }} data-testid="home-place">
              {place ? `${place.id === 'the_unknown' ? 'Somewhere near' : 'In'} ${place.name}` : 'Out on open land'} · {Math.round(home.rect.maxX - home.rect.minX)} × {Math.round(home.rect.maxZ - home.rect.minZ)} m
            </p>
            <section className="section">
              <Toggle label="Show my home on the map" hint="Others see a quiet pin with its name and yours — never whether you’re here." checked={home.pinned} onChange={(v) => homeActions.pin(v)} testId="home-pin" />
              <div>
                <button type="button" className="btn btn--ghost btn--sm" disabled={pending} onClick={() => homeActions.clear()} data-testid="home-panel-stop">
                  Stop calling this home
                </button>
              </div>
              {recent ? (
                <p className="muted small" role="status" data-testid="home-panel-result" style={{ margin: 0 }}>
                  {recent.text}
                </p>
              ) : null}
            </section>
          </>
        ) : (
          <>
            <p className="notyet__lede">Build a house, then make it your home.</p>
            <ol className="muted small" data-testid="home-howto" style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>Build at least four walls with a doorway, and put your own roof on them (Build → Roofs).</li>
              <li>Still in build mode, pick any piece of your house with the remove tool.</li>
              <li>
                Choose <strong>Make this my home</strong>. You can show it on the map if you like; it stays off until you do.
              </li>
            </ol>
          </>
        )}
        <Planned />
      </div>
    </Sheet>
  );
}
