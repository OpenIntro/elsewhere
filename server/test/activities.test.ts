/**
 * Building activities: validation (range, same side of the wall, rate / per-day
 * limits, moderation), rules (one vote per profile, workshop stages with
 * DISTINCT players, completion → persistent world change), persistence across
 * a service restart, and keepers never being players.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_KEYS,
  CONFIG,
  KEEPERS,
  PROJECTS,
  curiositiesForDay,
  getInteractable,
  interiorAnchor,
  parseActivityData,
  pollForDay,
  rotateOffset,
  getInterior,
  type ActivityResultPayload,
  type BoardEntry,
  type ChatMessage,
  type PollData,
  type ProjectData,
} from '@elsewhere/shared';
import { createPersistence } from '../src/persistence/index.js';
import { RateLimiter } from '../src/moderation/index.js';
import { buildArticles } from '../src/gazette/index.js';
import { DAY_MS, makeWorld, type World } from './helpers.js';

const HOUR_MS = DAY_MS / 24;

/** Advance the fake clock, ticking the activity hooks like the room does (20 Hz, coarse here). */
function tick(w: World, ms: number, step = 250): void {
  for (let t = 0; t < ms; t += step) {
    w.clock.advance(step);
    for (const h of w.hooks) h.tick?.(w.ctx, step);
  }
}
const at = (interior: string, anchor: string) => interiorAnchor(interior, anchor).position;
const ia = (id: string) => getInteractable(id)!;
async function act(w: World, sid: string, payload: { station: string; action: string; item?: string; text?: string; option?: number; entryId?: string }): Promise<ActivityResultPayload> {
  await w.activities.handle(w.ctx, sid, payload);
  const r = w.received(sid, 'activity_result') as ActivityResultPayload[];
  return r[r.length - 1]!;
}
const data = <T>(w: World, key: string, fallback: T) => parseActivityData<T>(w.state.activities.get(key)?.data, fallback);
/** A point `d` metres outside the given wall face of a building, behind a local point. */
function outsideBehind(interiorId: string, local: { x: number; z: number }, face: 'back' | 'left'): { x: number; z: number } {
  const i = getInterior(interiorId)!;
  const off = face === 'back' ? { x: local.x, z: -(i.footprint.halfDepth + 0.45) } : { x: -(i.footprint.halfWidth + 0.45), z: local.z };
  const o = rotateOffset(off, i.footprint.yaw);
  return { x: i.footprint.center.x + o.x, z: i.footprint.center.z + o.z };
}
function localOf(interiorId: string, p: { x: number; z: number }) {
  const i = getInterior(interiorId)!;
  const dx = p.x - i.footprint.center.x;
  const dz = p.z - i.footprint.center.z;
  const c = Math.cos(-i.footprint.yaw);
  const s = Math.sin(-i.footprint.yaw);
  return { x: dx * c + dz * s, z: -dx * s + dz * c };
}

describe('building activities', { timeout: 120_000 }, () => {
  it('keepers: on duty by the world clock, move along their route, never players, never in memory or chat', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', at('cafe', 'entrance').x, at('cafe', 'entrance').z);
    // 07:12 at the epoch: the café (06:30) and workshop (07:00) are open; the store and hall (08:00) not yet.
    const ks = (id: string) => w.state.keepers.get(id)!;
    expect(w.state.keepers.size).toBe(KEEPERS.length);
    expect(ks('keeper_barista').present).toBe(true);
    expect(ks('keeper_tinkerer').present).toBe(true);
    expect(ks('keeper_shopkeeper').present).toBe(false);
    expect(ks('keeper_clerk').present).toBe(false);
    expect(w.state.activities.get(ACTIVITY_KEYS.building('cafe'))!.active).toBe(true);
    expect(w.state.activities.get(ACTIVITY_KEYS.building('general_store'))!.active).toBe(false);
    const start = { x: ks('keeper_barista').x, z: ks('keeper_barista').z };
    tick(w, 60_000);
    const moved = Math.hypot(ks('keeper_barista').x - start.x, ks('keeper_barista').z - start.z) > 0.2 || ks('keeper_barista').anim === 'walk';
    expect(moved || ks('keeper_barista').task !== '').toBe(true);
    tick(w, HOUR_MS * 1.2); // past 08:00
    expect(ks('keeper_shopkeeper').present).toBe(true);
    expect(ks('keeper_clerk').present).toBe(true);
    // Late at night everyone is off duty; buildings stay open to walk in (no keeper, "closed").
    tick(w, HOUR_MS * 15.5, 2000);
    expect(KEEPERS.every((k) => !ks(k.id).present)).toBe(true);
    expect(w.state.activities.get(ACTIVITY_KEYS.building('cafe'))!.active).toBe(false);
    // Never players: not in the player map, the online count is the real one, no memory, no chat lines.
    expect(w.state.players.size).toBe(1);
    expect([...w.state.players.keys()]).toEqual([a]);
    for (const k of KEEPERS) expect(w.state.players.has(k.id)).toBe(false);
    const events = await w.memory.list({ limit: 200 });
    for (const e of events) for (const actor of e.actors) expect(KEEPERS.some((k) => k.name === actor.name || k.id === actor.profileId)).toBe(false);
    expect(w.chat.recent()).toEqual([]);
    expect((w.received(a, 'chat') as ChatMessage[]).length).toBe(0);
    // Presence counts real players only.
    expect(w.state.activities.get(ACTIVITY_KEYS.building('cafe'))!.value).toBe(1);
    await w.close();
  });

  it('café: ordering needs the counter (no ordering through the wall), the barista on duty, free hands; cooldown; sips; it runs out', async () => {
    const w = await makeWorld();
    const talk = ia('keeper_barista').position;
    const a = await w.join('Alice', talk.x, talk.z);
    const b = await w.join('Bob', at('cafe', 'table_1').x, at('cafe', 'table_1').z);
    // Too far (Bob across the room).
    expect((await act(w, b, { station: 'keeper_barista', action: 'order', item: 'tea' })).error).toBe('too_far');
    // Through the wall: Carol stands just outside the café's back wall behind the counter.
    const out = outsideBehind('cafe', localOf('cafe', at('cafe', 'barista')), 'back');
    const c = await w.join('Carol', out.x, out.z);
    expect((await act(w, c, { station: 'keeper_barista', action: 'order', item: 'tea' })).error).toBe('too_far');
    // Off the menu.
    expect((await act(w, a, { station: 'keeper_barista', action: 'order', item: 'whisky' })).error).toBe('bad_request');
    const ok = await act(w, a, { station: 'keeper_barista', action: 'order', item: 'coffee' });
    expect(ok.ok).toBe(true);
    expect(w.state.players.get(a)!.held).toBe('cup_coffee'); // synced: everyone sees Alice holding it
    expect(w.state.keepers.get('keeper_barista')!.anim).toBe('interact');
    // Cooldown.
    expect((await act(w, a, { station: 'keeper_barista', action: 'order', item: 'tea' })).error).toBe('cooldown');
    // Hands full (holding an apple-like pickup item).
    w.move(b, talk.x, talk.z);
    w.state.players.get(b)!.held = 'apple';
    expect((await act(w, b, { station: 'keeper_barista', action: 'order', item: 'tea' })).error).toBe('forbidden');
    // Sips: each is an animation one-shot; the last one empties the cup.
    for (let i = 0; i < CONFIG.activities.drinkSips - 1; i++) {
      w.clock.advance(CONFIG.activities.sipCooldownMs + 10);
      expect((await act(w, a, { station: 'drink', action: 'sip' })).ok).toBe(true);
    }
    expect(w.state.players.get(a)!.anim).toBe('interact');
    w.clock.advance(CONFIG.activities.sipCooldownMs + 10);
    await act(w, a, { station: 'drink', action: 'sip' });
    expect(w.state.players.get(a)!.held).toBe('');
    // A second drink runs out by time.
    w.clock.advance(CONFIG.activities.drinkCooldownMs);
    expect((await act(w, a, { station: 'keeper_barista', action: 'order', item: 'cocoa' })).ok).toBe(true);
    tick(w, CONFIG.activities.drinkDurationMs + 3000, 1000);
    expect(w.state.players.get(a)!.held).toBe('');
    expect((w.received(a, 'activity_event') as { kind: string }[]).some((e) => e.kind === 'drink_done')).toBe(true);
    // Closed at night: no barista, no orders.
    tick(w, HOUR_MS * 16, 4000);
    w.clock.advance(CONFIG.activities.drinkCooldownMs);
    expect((await act(w, a, { station: 'keeper_barista', action: 'order', item: 'tea' })).error).toBe('forbidden');
    await w.close();
  });

  it('piano: notes only from the piano (not through the wall), relayed to the café and nearby, anim on the player; rate limit rule', async () => {
    const w = await makeWorld();
    const piano = ia('station_cafe_piano').position;
    const a = await w.join('Alice', at('cafe', 'piano').x, at('cafe', 'piano').z);
    const inCafe = await w.join('Bob', at('cafe', 'table_2').x, at('cafe', 'table_2').z);
    const far = await w.join('Dan', 0, 40); // the waterfront
    const out = outsideBehind('cafe', localOf('cafe', piano), 'back');
    const wall = await w.join('Carol', out.x, out.z);
    expect(Math.hypot(out.x - piano.x, out.z - piano.z)).toBeLessThan(2.2 + CONFIG.interaction.serverSlack);
    w.activities.pianoNote(w.ctx, a, { note: 7 });
    expect(w.received(inCafe, 'piano_note')).toEqual([expect.objectContaining({ by: a, note: 7 })]);
    expect(w.received(wall, 'piano_note').length).toBe(1); // right outside the wall: heard (muffled client-side)
    expect(w.received(far, 'piano_note').length).toBe(0);
    expect(w.state.players.get(a)!.anim).toBe('interact');
    // Invalid notes are ignored; through the wall is refused.
    w.activities.pianoNote(w.ctx, a, { note: 99 });
    w.activities.pianoNote(w.ctx, wall, { note: 3 });
    expect(w.received(inCafe, 'piano_note').length).toBe(1);
    expect((w.received(wall, 'activity_result') as ActivityResultPayload[]).at(-1)!.error).toBe('too_far');
    // WorldRoom applies the 'piano' bucket (16 burst, 8/s): the 17th note in a burst is refused.
    const rl = new RateLimiter(CONFIG.rateLimits, w.clock.now);
    const taken = Array.from({ length: 17 }, () => rl.take('s', 'piano'));
    expect(taken.slice(0, 16).every((x) => x === 0)).toBe(true);
    expect(taken[16]).toBeGreaterThan(0);
    expect(new RateLimiter(CONFIG.rateLimits, w.clock.now).take('s', 'activity')).toBe(0);
    await w.close();
  });

  it('stage and lectern: holder tracked from real positions; their proximity chat carries through the building', async () => {
    const w = await makeWorld();
    const st = at('cafe', 'stage');
    const a = await w.join('Alice', st.x, st.z);
    const b = await w.join('Bob', at('cafe', 'table_2').x, at('cafe', 'table_2').z);
    tick(w, 500);
    expect(w.state.activities.get(ACTIVITY_KEYS.stage)!.holder).toBe(a);
    expect(w.activities.chatReach(w.ctx, a)).toEqual({ interiorId: 'cafe', stage: 'cafe_stage' });
    expect(w.activities.chatReach(w.ctx, b)).toBeNull();
    w.chat.handleChat(w.ctx, a, { channel: 'proximity', text: 'good evening, everyone' });
    const heard = w.received(b, 'chat') as ChatMessage[];
    expect(heard.at(-1)!.stage).toBe('cafe_stage');
    w.move(a, at('cafe', 'table_1').x, at('cafe', 'table_1').z);
    tick(w, 500);
    expect(w.state.activities.get(ACTIVITY_KEYS.stage)!.holder).toBe('');
    // Lectern.
    const lec = at('town_hall', 'lectern');
    w.move(a, lec.x, lec.z);
    tick(w, 500);
    expect(w.activities.chatReach(w.ctx, a)?.stage).toBe('hall_lectern');
    await w.leave(a);
    tick(w, 500);
    expect(w.state.activities.get(ACTIVITY_KEYS.lectern)!.holder).toBe('');
    await w.close();
  });

  it('store: today’s curiosities only, shopkeeper on duty, one per profile per world-day, into the collection', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', at('general_store', 'display').x, at('general_store', 'display').z);
    const today = curiositiesForDay(w.ctx.worldTime().day);
    expect(today.length).toBe(3);
    // 07:12: the store is not open yet.
    expect((await act(w, a, { station: 'station_store_shelf', action: 'take', item: today[0] })).error).toBe('forbidden');
    tick(w, HOUR_MS);
    const notToday = ['postcard', 'brass_key', 'tin_whistle', 'glass_marble'].find((x) => !today.includes(x as never))!;
    expect((await act(w, a, { station: 'station_store_shelf', action: 'take', item: notToday })).error).toBe('bad_request');
    const r = await act(w, a, { station: 'station_store_shelf', action: 'take', item: today[0] });
    expect(r.ok).toBe(true);
    expect(w.ctx.getProfile(a)!.inventory).toContain(today[0]);
    expect((await act(w, a, { station: 'station_store_shelf', action: 'take', item: today[1] })).error).toBe('cooldown');
    // Next world day (during opening hours): allowed again.
    tick(w, HOUR_MS * 24, 4000);
    const tomorrow = curiositiesForDay(w.ctx.worldTime().day);
    expect((await act(w, a, { station: 'station_store_shelf', action: 'take', item: tomorrow[0] })).ok).toBe(true);
    await w.close();
  });

  it('notice board: moderation, length, per-player limit, owner/admin removal, report, expiry, writing pause', async () => {
    const w = await makeWorld({ activityTunables: { noticeExpiryMs: 10 * 60_000 } });
    const nb = at('town_hall', 'notice_board');
    const a = await w.join('Alice', nb.x, nb.z);
    const b = await w.join('Bob', nb.x, nb.z);
    const far = await w.join('Dan', at('town_hall', 'entrance').x, at('town_hall', 'entrance').z);
    const pin = (sid: string, text: string) => act(w, sid, { station: 'station_hall_notices', action: 'pin', text });
    expect((await pin(far, 'hello')).error).toBe('too_far');
    expect((await pin(a, '   ')).error).toBe('bad_request');
    expect((await pin(a, 'x'.repeat(CONFIG.activities.noticeMaxLength + 1))).error).toBe('message_too_long');
    expect((await pin(a, 'Lost: a shit umbrella')).ok).toBe(true);
    let entries = data<{ entries: BoardEntry[] }>(w, ACTIVITY_KEYS.board('hall_notices'), { entries: [] }).entries;
    expect(entries.length).toBe(1);
    expect(entries[0]!.t).toBe('Lost: a s*** umbrella');
    expect(entries[0]!.a).toBe('Alice');
    expect((await pin(a, 'Second notice')).ok).toBe(true);
    expect((await pin(a, 'Third notice')).error).toBe('cooldown'); // 2 per player
    // Only the owner removes; Bob may report.
    const id = entries[0]!.id;
    expect((await act(w, b, { station: 'station_hall_notices', action: 'remove', entryId: id })).error).toBe('forbidden');
    expect((await act(w, b, { station: 'station_hall_notices', action: 'report', entryId: id })).ok).toBe(true);
    const reports = await w.persistence.reports.list(5);
    expect(reports[0]).toMatchObject({ targetProfileId: w.state.players.get(a)!.profileId, reason: 'inappropriate_content' });
    expect(reports[0]!.evidence[0]).toContain('umbrella');
    expect((await act(w, a, { station: 'station_hall_notices', action: 'remove', entryId: id })).ok).toBe(true);
    entries = data<{ entries: BoardEntry[] }>(w, ACTIVITY_KEYS.board('hall_notices'), { entries: [] }).entries;
    expect(entries.map((e) => e.t)).toEqual(['Second notice']);
    // Admin removal.
    expect(await w.activities.adminRemoveNote(entries[0]!.id)).toBe(true);
    expect(w.state.activities.get(ACTIVITY_KEYS.board('hall_notices'))!.value).toBe(0);
    // Expiry.
    expect((await pin(b, 'Bake sale at noon')).ok).toBe(true);
    tick(w, 10 * 60_000 + 2000, 1000);
    expect(w.state.activities.get(ACTIVITY_KEYS.board('hall_notices'))!.value).toBe(0);
    // Chat-muted players cannot write.
    await w.moderation.sanction({ profileId: w.state.players.get(b)!.profileId, kind: 'chat_mute', minutes: 5, reason: 'test', createdBy: 'test' });
    expect((await pin(b, 'hello again')).error).toBe('forbidden');
    // Memory records that a notice went up, never its text.
    const ev = await w.memory.list({ kind: 'notice_pinned' });
    expect(ev.length).toBe(3);
    expect(JSON.stringify(ev)).not.toContain('umbrella');
    await w.close();
  });

  it('town poll: one vote per profile, real tallies, result recorded only when the period ends with votes', async () => {
    const w = await makeWorld();
    const box = at('town_hall', 'meeting_table');
    const a = await w.join('Alice', box.x, box.z);
    const b = await w.join('Bob', box.x, box.z);
    let p = data<PollData>(w, ACTIVITY_KEYS.poll, {} as PollData);
    expect(p.tallies.every((n) => n === 0)).toBe(true);
    expect((await act(w, a, { station: 'station_hall_poll', action: 'vote', option: 99 })).error).toBe('bad_request');
    expect((await act(w, a, { station: 'station_hall_poll', action: 'vote', option: 1 })).ok).toBe(true);
    const again = await act(w, a, { station: 'station_hall_poll', action: 'vote', option: 0 });
    expect(again.ok).toBe(false);
    expect(again.data).toEqual({ voted: 1 });
    expect((await act(w, b, { station: 'station_hall_poll', action: 'vote', option: 1 })).ok).toBe(true);
    p = data<PollData>(w, ACTIVITY_KEYS.poll, {} as PollData);
    expect(p.tallies[1]).toBe(2);
    expect(w.state.activities.get(ACTIVITY_KEYS.poll)!.value).toBe(2);
    const question = p.question;
    expect(await w.memory.list({ kind: 'poll_closed' })).toEqual([]);
    // The world day ends → the period closes → a real result is recorded (and the Gazette can use it).
    tick(w, DAY_MS + 3000, 1000);
    await w.persistence.flush();
    await new Promise((r) => setTimeout(r, 50));
    const closed = await w.memory.list({ kind: 'poll_closed' });
    expect(closed.length).toBe(1);
    expect(closed[0]!.data).toMatchObject({ question, votes: 2 });
    expect(closed[0]!.actors.map((x) => x.name).sort()).toEqual(['Alice', 'Bob']);
    p = data<PollData>(w, ACTIVITY_KEYS.poll, {} as PollData);
    expect(p.question).toBe(pollForDay(w.ctx.worldTime().day).poll.question);
    expect(p.tallies.every((n) => n === 0)).toBe(true);
    expect(p.last?.tallies[1]).toBe(2);
    // A period nobody voted in records nothing.
    tick(w, DAY_MS + 3000, 1000);
    await new Promise((r) => setTimeout(r, 50));
    expect((await w.memory.list({ kind: 'poll_closed' })).length).toBe(1);
    await w.close();
  });

  it('workshop: per-day limit, stages need distinct players, completion makes a permanent change and starts the next project', async () => {
    const w = await makeWorld({ activityTunables: { projectStageContributions: [3, 3], projectStageDistinct: [2, 2], projectDailyPerProfile: 3 } });
    const anvil = at('workshop', 'anvil');
    const a = await w.join('Alice', anvil.x, anvil.z);
    const b = await w.join('Bob', anvil.x, anvil.z);
    const work = async (sid: string, station = 'station_workshop_anvil') => {
      w.clock.advance(CONFIG.activities.projectCooldownMs + 10);
      return w.interact(sid, station);
    };
    const proj = () => data<ProjectData>(w, ACTIVITY_KEYS.project, {} as ProjectData);
    // Alice alone: three contributions reach the count but not the distinct-player rule.
    for (let i = 0; i < 3; i++) expect((await work(a)).ok).toBe(true);
    expect(proj().stage).toBe(0);
    expect(proj().contributions).toBe(3);
    // Her daily limit is used up.
    const capped = await work(a);
    expect(capped.ui && 'message' in capped.ui ? capped.ui.message : '').toMatch(/share today/);
    expect(proj().contributions).toBe(3);
    // A cooldown between contributions.
    w.clock.advance(CONFIG.activities.projectCooldownMs + 10);
    await w.interact(b, 'station_workshop_kiln');
    expect((await w.interact(b, 'station_workshop_kiln')).error).toBe('cooldown');
    expect(proj().stage).toBe(1); // Bob made it two distinct players
    expect((await w.memory.list({ kind: 'project_stage' }))[0]!.actors.map((x) => x.name).sort()).toEqual(['Alice', 'Bob']);
    expect(w.state.players.get(b)!.anim).toBe('interact');
    // Next stage: Bob twice more (still 1 distinct this stage), then Alice on the next world day.
    await work(b, 'station_workshop_lumber');
    await work(b, 'station_workshop_lumber');
    expect(proj().stage).toBe(1);
    tick(w, DAY_MS, 4000);
    expect((await work(a)).ok).toBe(true);
    expect(proj().completed).toEqual([PROJECTS[0]!.id]);
    expect(proj().projectId).toBe(PROJECTS[1]!.id);
    expect(proj().stage).toBe(0);
    const done = await w.memory.list({ kind: 'project_completed' });
    expect(done.length).toBe(1);
    expect(done[0]!.significance).toBe(3);
    expect(done[0]!.actors.map((x) => x.name).sort()).toEqual(['Alice', 'Bob']);
    expect(w.received(a, 'world_event').length).toBeGreaterThan(0);
    await w.close();
  });

  it('persistence round trip across a service restart: notices, poll tally, workshop progress + completed project, hearth, guest book, nets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-act-'));
    try {
      const tun = { projectStageContributions: [2, 2], projectStageDistinct: [1, 1], projectDailyPerProfile: 5 };
      const w = await makeWorld({ persistence: createPersistence({ dataDir: dir }), activityTunables: tun });
      const a = await w.join('Alice', at('town_hall', 'notice_board').x, at('town_hall', 'notice_board').z);
      await act(w, a, { station: 'station_hall_notices', action: 'pin', text: 'Choir practice on Thursday' });
      w.move(a, at('town_hall', 'meeting_table').x, at('town_hall', 'meeting_table').z);
      await act(w, a, { station: 'station_hall_poll', action: 'vote', option: 2 });
      w.move(a, at('workshop', 'kiln').x, at('workshop', 'kiln').z);
      for (let i = 0; i < 5; i++) {
        w.clock.advance(CONFIG.activities.projectCooldownMs + 10);
        await w.interact(a, 'station_workshop_kiln');
      }
      w.move(a, at('house_1', 'hearth').x, at('house_1', 'hearth').z);
      await w.interact(a, 'station_house_1_hearth');
      w.move(a, at('house_1', 'table').x, at('house_1', 'table').z);
      expect((await act(w, a, { station: 'station_house_1_guestbook', action: 'sign', text: 'Lovely kettle. — A' })).ok).toBe(true);
      expect((await act(w, a, { station: 'station_house_1_guestbook', action: 'sign', text: 'Again!' })).error).toBe('cooldown');
      w.move(a, at('boathouse', 'nets').x, at('boathouse', 'nets').z);
      await w.interact(a, 'station_boathouse_nets');
      const before = data<ProjectData>(w, ACTIVITY_KEYS.project, {} as ProjectData);
      expect(before.completed).toEqual([PROJECTS[0]!.id]);
      expect(before.contributions).toBe(1);
      await w.dispose();
      await w.close();

      const w2 = await makeWorld({ persistence: createPersistence({ dataDir: dir }), activityTunables: tun, clock: w.clock });
      const notes = data<{ entries: BoardEntry[] }>(w2, ACTIVITY_KEYS.board('hall_notices'), { entries: [] }).entries;
      expect(notes.map((n) => n.t)).toEqual(['Choir practice on Thursday']);
      expect(data<PollData>(w2, ACTIVITY_KEYS.poll, {} as PollData).tallies[2]).toBe(1);
      const after = data<ProjectData>(w2, ACTIVITY_KEYS.project, {} as ProjectData);
      expect(after.completed).toEqual([PROJECTS[0]!.id]);
      expect(after.projectId).toBe(PROJECTS[1]!.id);
      expect(after.contributions).toBe(1);
      expect(w2.state.activities.get(ACTIVITY_KEYS.hearth('house_1'))!.active).toBe(true);
      expect(data<{ entries: BoardEntry[] }>(w2, ACTIVITY_KEYS.board('book_house_1'), { entries: [] }).entries[0]!.t).toBe('Lovely kettle. — A');
      expect(w2.state.activities.get(ACTIVITY_KEYS.nets)!.value).toBe(1);
      // The same profile still cannot vote twice after the restart.
      const back = await w2.join('Alice', at('town_hall', 'meeting_table').x, at('town_hall', 'meeting_table').z, (await w2.persistence.profiles.get(w.state.players.get(a)!.profileId))!);
      expect((await act(w2, back, { station: 'station_hall_poll', action: 'vote', option: 0 })).ok).toBe(false);
      await w2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('homes and boathouse: hearth burns down, kettle boils and whistles (world behaviour), nets need many hands', async () => {
    const w = await makeWorld({ activityTunables: { hearthBurnMs: 60_000, netSections: 2 } });
    const a = await w.join('Alice', at('house_2', 'hearth').x, at('house_2', 'hearth').z);
    await w.interact(a, 'station_house_2_hearth');
    expect(w.state.activities.get(ACTIVITY_KEYS.hearth('house_2'))!.active).toBe(true);
    tick(w, 62_000, 1000);
    expect(w.state.activities.get(ACTIVITY_KEYS.hearth('house_2'))!.active).toBe(false);
    w.move(a, at('house_2', 'kitchen').x, at('house_2', 'kitchen').z);
    await w.interact(a, 'station_house_2_kettle');
    expect(w.state.activities.get(ACTIVITY_KEYS.kettle('house_2'))!.active).toBe(true);
    tick(w, CONFIG.activities.kettleBoilMs + 1500, 500);
    const evs = w.received(a, 'activity_event') as { kind: string; by: string }[];
    expect(evs.find((e) => e.kind === 'kettle_whistle')?.by).toBe('');
    // Nets: one mend per profile per day; two people finish a net.
    const b = await w.join('Bob', at('boathouse', 'nets').x, at('boathouse', 'nets').z);
    w.move(a, at('boathouse', 'nets').x, at('boathouse', 'nets').z);
    await w.interact(a, 'station_boathouse_nets');
    await w.interact(a, 'station_boathouse_nets');
    expect(w.state.activities.get(ACTIVITY_KEYS.nets)!.value).toBe(1);
    await w.interact(b, 'station_boathouse_nets');
    expect(w.state.activities.get(ACTIVITY_KEYS.nets)!.value).toBe(0);
    expect(parseActivityData<{ nets: number }>(w.state.activities.get(ACTIVITY_KEYS.nets)!.data, { nets: 0 }).nets).toBe(1);
    expect((await w.memory.list({ kind: 'nets_mended' }))[0]!.actors.length).toBe(2);
    await w.close();
  });

  it('Gazette: real activity events become articles that cite their events (and never invent people)', async () => {
    const w = await makeWorld({ activityTunables: { projectStageContributions: [1, 1, 1], projectStageDistinct: [1, 1, 1] } });
    const a = await w.join('Alice', at('workshop', 'anvil').x, at('workshop', 'anvil').z);
    for (let i = 0; i < 3; i++) {
      w.clock.advance(CONFIG.activities.projectCooldownMs + 10);
      await w.interact(a, 'station_workshop_anvil');
    }
    w.move(a, at('town_hall', 'meeting_table').x, at('town_hall', 'meeting_table').z);
    await act(w, a, { station: 'station_hall_poll', action: 'vote', option: 0 });
    tick(w, DAY_MS + 3000, 1000);
    await new Promise((r) => setTimeout(r, 50));
    const events = (await w.memory.list({ limit: 100 })).reverse();
    const arts = buildArticles(events, { epochMs: w.collective.facts().clockEpochMs, dayLengthMs: DAY_MS });
    const done = arts.find((x) => x.templateId === 'project_completed')!;
    expect(done.section).toBe('front_page');
    expect(done.body).toContain('Alice');
    expect(done.eventIds.length).toBe(1);
    const poll = arts.find((x) => x.templateId === 'poll_closed')!;
    expect(poll.body).toContain('1 resident(s) voted');
    for (const art of arts) for (const k of KEEPERS) expect(art.body).not.toContain(k.name);
    await w.close();
  });

  it('a poll period that ended while the server was down is closed (and recorded) at the next start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-poll-'));
    try {
      const w = await makeWorld({ persistence: createPersistence({ dataDir: dir }) });
      const a = await w.join('Alice', at('town_hall', 'meeting_table').x, at('town_hall', 'meeting_table').z);
      expect((await act(w, a, { station: 'station_hall_poll', action: 'vote', option: 1 })).ok).toBe(true);
      await w.dispose();
      await w.close();
      w.clock.advance(DAY_MS * 1.5); // down over the day change
      const w2 = await makeWorld({ persistence: createPersistence({ dataDir: dir }), clock: w.clock });
      const closed = await w2.memory.list({ kind: 'poll_closed' });
      expect(closed.length).toBe(1);
      expect(closed[0]!.data).toMatchObject({ votes: 1 });
      expect(data<PollData>(w2, ACTIVITY_KEYS.poll, {} as PollData).last?.tallies[1]).toBe(1);
      await w2.dispose();
      await w2.close();
      // and never twice
      const w3 = await makeWorld({ persistence: createPersistence({ dataDir: dir }), clock: w.clock });
      expect((await w3.memory.list({ kind: 'poll_closed' })).length).toBe(1);
      await w3.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
