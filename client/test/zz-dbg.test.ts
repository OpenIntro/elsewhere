import { it } from 'vitest';
import { randomAppearance } from '@elsewhere/shared';
import { buildCharacter } from '../src/characters/build';
it('dbg', () => {
  for (const sd of [3, 11]) {
  const a = randomAppearance(sd);
  const b = buildCharacter(a);
  const idx = b.geometry.getIndex()!; const si = b.geometry.getAttribute('skinIndex');
  const per: Record<number, number> = {};
  for (let i = 0; i < idx.count; i += 3) { const k = si.getX(idx.getX(i)); per[k] = (per[k] ?? 0) + 1; }
  console.log('PER', idx.count/3, JSON.stringify(per), JSON.stringify(a));
  }
});
