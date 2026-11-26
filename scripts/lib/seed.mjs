/**
 * Test tooling: place a list of pieces through the REAL server path (a
 * protocol client sending C2S.buildPlace / C2S.buildClear, so every rule is
 * validated, persisted and broadcast like a player's) — used by the
 * screenshot tool to stage showcase houses. The server must allow the range
 * (e.g. BUILD_RANGE=400 on a scratch dev server) because this client does
 * not walk. Not part of the product.
 */
import { Client } from '@colyseus/sdk';
import { CONFIG, ROOM_NAME } from '@elsewhere/shared';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Join as a fresh guest (or with `token`); returns helpers to place / clear and wait for answers. */
export async function builderClient(base, { name = 'Builder', token } = {}) {
  let tok = token;
  if (!tok) {
    const res = await fetch(`${base}/api/session/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    tok = (await res.json()).token;
  }
  const room = await new Client(base.replace(/^http/, 'ws')).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token: tok });
  const results = new Map();
  room.onMessage('build_result', (m) => results.set(m.reqId, m));
  room.onMessage('*', () => undefined);
  let req = 1;
  const ask = async (type, payload) => {
    const reqId = ++req;
    room.send(type, { reqId, ...payload });
    for (let i = 0; i < 400 && !results.has(reqId); i++) await sleep(25);
    const r = results.get(reqId);
    if (!r) throw new Error(`no answer to ${type}`);
    return r;
  };
  return {
    token: tok,
    room,
    place: (p) => ask('build_place', { kind: p.kind, variant: p.variant, x: p.x, z: p.z, rot: p.rot ?? 0, level: p.level ?? 0, ...(p.text ? { text: p.text } : {}), ...(p.params ? { params: p.params } : {}) }),
    clear: (id) => ask('build_clear', { id }),
    leave: () => room.leave().catch(() => undefined),
  };
}

/** Place every piece (clearing the listed bushes first); returns refusals. */
export async function seedPlan(base, plan, { clear = [], name } = {}) {
  const b = await builderClient(base, { name });
  const refused = [];
  try {
    for (const id of clear) {
      const r = await b.clear(id);
      if (!r.ok && r.reason !== 'already_cleared') refused.push(`clear ${id}: ${r.reason}`);
    }
    for (const p of plan) {
      const r = await b.place(p);
      if (!r.ok) refused.push(`${p.kind}@${p.x},${p.z} L${p.level ?? 0}: ${r.reason} ${r.message ?? ''}`);
    }
  } finally {
    await b.leave();
  }
  return refused;
}
