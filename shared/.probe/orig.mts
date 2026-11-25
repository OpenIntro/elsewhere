import { TREES, LOCATIONS } from './orig/shared/src/index.js';
const w = LOCATIONS.find((l) => l.id === 'woods')!;
console.log('orig woods trees', TREES.filter((t) => Math.hypot(t.position.x - w.center.x, t.position.z - w.center.z) < w.radius).length, TREES.length);
