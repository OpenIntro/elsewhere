import { describe, expect, it } from 'vitest';
import { CONFIG, getInteractable, type ObjectEvent, type SeatInteractable } from '@elsewhere/shared';
import { makeWorld } from './helpers.js';

describe('interactions', { timeout: 60_000 }, () => {
  it('seats: no double seating, nearest free seat on benches, freed on stand and on leave', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    const b = await w.join('Bob', 0, 10);
    const chair = getInteractable('chair_cafe_1a') as SeatInteractable;
    expect(await w.interact(a, chair.id)).toMatchObject({ ok: true });
    expect(w.state.players.get(a)!.seat).toBe('chair_cafe_1a#0');
    expect(w.state.players.get(a)!.anim).toBe('sit');
    expect(w.state.players.get(a)!.x).toBeCloseTo(chair.seats[0]!.position.x);
    expect(await w.interact(b, chair.id)).toMatchObject({ ok: false, error: 'occupied' });
    expect(w.state.objects.get(chair.id)!.value).toBe(1);
    w.interactions.stand(w.ctx, a);
    expect(w.state.players.get(a)!.seat).toBe('');
    expect(w.state.objects.get(chair.id)!.value).toBe(0);
    expect(await w.interact(b, chair.id)).toMatchObject({ ok: true });
    await w.leave(b);
    expect(w.state.objects.get(chair.id)!.value).toBe(0);

    const bench = 'bench_square_1';
    const c = await w.join('Cara', 0, 10);
    expect(await w.interact(a, bench, '1')).toMatchObject({ ok: true });
    expect(await w.interact(c, bench, '1')).toMatchObject({ ok: false, error: 'occupied' });
    expect(await w.interact(c, bench)).toMatchObject({ ok: true });
    expect(w.state.objects.get(bench)!.value).toBe(3);
    expect(w.state.players.get(c)!.seat).toBe(`${bench}#0`);
    const d = await w.join('Dan', 0, 10);
    expect(await w.interact(d, bench)).toMatchObject({ ok: false, error: 'occupied' });
    await new Promise((r) => setTimeout(r, 30));
    expect((await w.memory.list({ kind: 'sat_together' })).length).toBe(1);
    await w.close();
  });

  it('bell: per-player cooldown, ring count, broadcast to everyone', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    const far = await w.join('Far', 40, 40);
    expect(await w.interact(a, 'bell_town_hall')).toMatchObject({ ok: true });
    expect(await w.interact(a, 'bell_town_hall')).toMatchObject({ ok: false, error: 'cooldown' });
    expect((w.received(far, 'object_event') as ObjectEvent[]).filter((e) => e.kind === 'bell_rung').length).toBe(1);
    w.clock.advance(CONFIG.interaction.bellCooldownMs);
    expect(await w.interact(a, 'bell_town_hall')).toMatchObject({ ok: true });
    expect(w.state.objects.get('bell_town_hall')!.value).toBe(2);
    await w.close();
  });

  it('doors toggle and auto-close; lights toggle with cooldown', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    const door = getInteractable('pickup_apple') && (await import('@elsewhere/shared')).BUILDINGS[0]!.doorId;
    await w.interact(a, door);
    expect(w.state.objects.get(door)!.active).toBe(true);
    w.clock.advance(CONFIG.interaction.doorAutoCloseMs + 1);
    expect(w.state.objects.get(door)!.active).toBe(false);
    const before = w.state.objects.get('light_square_1')!.active;
    expect(await w.interact(a, 'light_square_1')).toMatchObject({ ok: true });
    expect(w.state.objects.get('light_square_1')!.active).toBe(!before);
    expect(await w.interact(a, 'light_square_1')).toMatchObject({ ok: false, error: 'cooldown' });
    await w.close();
  });

  it('pickups: one holder, one held item, inventory recorded, respawn after drop elsewhere', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    const b = await w.join('Bob', 0, 10);
    expect(await w.interact(a, 'pickup_apple')).toMatchObject({ ok: true });
    expect(w.state.players.get(a)!.held).toBe('apple');
    expect(w.ctx.getProfile(a)!.inventory).toEqual(['apple']);
    expect(await w.interact(b, 'pickup_apple')).toMatchObject({ ok: false, error: 'occupied' });
    expect(await w.interact(a, 'pickup_wrench')).toMatchObject({ ok: false, error: 'forbidden' });
    w.move(a, 30, 30);
    w.interactions.dropItem(w.ctx, a);
    const o = w.state.objects.get('pickup_apple')!;
    expect(o.holder).toBe('');
    expect(o.active).toBe(false);
    w.clock.advance(CONFIG.interaction.pickupRespawnMs + 1);
    expect(o.active).toBe(true);
    expect(await w.interact(b, 'pickup_apple')).toMatchObject({ ok: true });
    await w.leave(b);
    expect(o.holder).toBe('');
    await w.close();
  });

  it('hidden objects: per-player discovery, first discoverer recorded once', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    const b = await w.join('Bob', 0, 10);
    expect(await w.interact(a, 'hidden_mossy_coin')).toMatchObject({ ok: true, ui: { panel: 'discovery', firstTime: true } });
    expect(await w.interact(a, 'hidden_mossy_coin')).toMatchObject({ ok: true, ui: { firstTime: false } });
    expect(await w.interact(b, 'hidden_mossy_coin')).toMatchObject({ ui: { firstTime: true } });
    const found = await w.memory.list({ kind: 'secret_found' });
    expect(found.map((e) => [e.actors[0]!.name, e.data?.firstOnIsland])).toEqual([
      ['Bob', false],
      ['Alice', true],
    ]);
    expect((await w.persistence.profiles.get(w.ctx.getProfile(a)!.id))!.discoveries).toEqual(['mossy_coin']);
    await w.close();
  });

  it('mail: sanitized, length-capped, range-checked, blocked authors hidden', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    const b = await w.join('Bob', 0, 10);
    const box = getInteractable('mailbox_post_office')!;
    w.move(a, box.position.x, box.position.z);
    w.move(b, box.position.x, box.position.z);
    await w.interactions.mailSend(w.ctx, a, { mailboxId: box.id, text: ' hello​\n\n\n\nfriend shit ' });
    expect((await w.persistence.mail.list(box.id, 5))[0]!.text).toBe('hello\n\nfriend s***');
    await w.interactions.mailSend(w.ctx, a, { mailboxId: box.id, text: 'x'.repeat(CONFIG.interaction.mailMaxLength + 1) });
    expect(w.received(a, 'error').at(-1)).toMatchObject({ code: 'message_too_long' });
    w.move(a, 100, 100);
    await w.interactions.mailSend(w.ctx, a, { mailboxId: box.id, text: 'far away' });
    expect(w.received(a, 'error').at(-1)).toMatchObject({ code: 'too_far' });
    await w.moderation.block(w.ctx, b, { target: a });
    w.clearSent();
    await w.interactions.mailRead(w.ctx, b, { mailboxId: box.id });
    expect(w.received(b, 'mail')[0]).toMatchObject({ mailboxId: box.id, notes: [] });
    await w.close();
  });
});
