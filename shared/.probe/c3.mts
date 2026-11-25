import { getBuilding, buildingLocal } from '../src/index.js';
const s = getBuilding('general_store');
for (const [x, z] of [[6.4, 1.6], [6.7, -3.4], [4.8, -7.3]]) { const p = buildingLocal(s, x, z); console.log('store', p.x.toFixed(2), p.z.toFixed(2)); }
