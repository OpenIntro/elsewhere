/** Inventory (real held item + collection + discoveries) and the Home "not yet" card. */
import { C2S, DISCOVERIES, ITEMS, type ItemId } from '@elsewhere/shared';
import { net } from '../../net/index.js';
import { useGameStore } from '../../state/gameStore.js';
import { Icon, ItemGlyph } from '../icons.js';
import { Empty, Sheet } from '../primitives.js';

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
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => net.send(C2S.dropItem, {})}>
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

const FUTURE = [
  { title: 'A home of your own', text: 'A little house in the Residential District, with a mailbox that’s yours.' },
  { title: 'Decorating', text: 'Furniture, plants and the odd mysterious object, arranged just so.' },
  { title: 'Shops & trading', text: 'Swap things with neighbours; the General Store finally opens its till.' },
  { title: 'A gentle currency', text: 'Earned by being around, never bought.' },
];

export function HomePanel({ onClose }: { onClose(): void }) {
  return (
    <Sheet title="Home" eyebrow="Not yet" icon="home" onClose={onClose} testId="panel-home">
      <div className="notyet">
        <svg className="notyet__art" viewBox="0 0 120 80" aria-hidden="true">
          <path d="M10 70h100" stroke="currentColor" strokeOpacity=".35" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M34 70V42l26-20 26 20v28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeDasharray="3 3.5" />
          <path d="M54 70V54h12v16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 3.5" />
          <circle cx="92" cy="20" r="6" fill="var(--accent)" opacity=".75" />
          <path d="M18 70c0-8 4-12 8-12s6 4 6 12" fill="none" stroke="var(--sage)" strokeWidth="1.6" />
        </svg>
        <p className="notyet__lede">Homes aren’t built yet. When they are, you’ll find them here.</p>
        <ul className="future">
          {FUTURE.map((f) => (
            <li key={f.title}>
              <span className="tag">Planned</span>
              <strong>{f.title}</strong>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
        <p className="muted small">Nothing on this page works yet — we’d rather say so than pretend.</p>
      </div>
    </Sheet>
  );
}
