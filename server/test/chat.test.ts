import { describe, expect, it } from 'vitest';
import { CONFIG, type ChatMessage } from '@elsewhere/shared';
import { makeWorld } from './helpers.js';

const texts = (msgs: unknown[]) => (msgs as ChatMessage[]).map((m) => m.text);

describe('chat + moderation', { timeout: 60_000 }, () => {
  it('proximity reaches only players within radius; global reaches everyone; whispers are private', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    const b = await w.join('Bob', 0, 10 + CONFIG.chat.proximityRadius - 1);
    const c = await w.join('Cara', 0, 10 + CONFIG.chat.proximityRadius + 5);
    w.chat.handleChat(w.ctx, a, { channel: 'proximity', text: 'hello near' });
    expect(texts(w.received(a, 'chat'))).toEqual(['hello near']);
    expect(texts(w.received(b, 'chat'))).toEqual(['hello near']);
    expect(texts(w.received(c, 'chat'))).toEqual([]);
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: 'hello all @Cara' });
    expect(texts(w.received(c, 'chat'))).toEqual(['hello all @Cara']);
    expect((w.received(c, 'chat')[0] as ChatMessage).mentions).toEqual(['cara']);
    expect(w.chat.recent().map((m) => m.text)).toEqual(['hello all @Cara']);
    w.clearSent();
    w.chat.handleWhisper(w.ctx, a, { to: c, text: 'psst' });
    expect(texts(w.received(c, 'chat'))).toEqual(['psst']);
    expect(texts(w.received(a, 'chat'))).toEqual(['psst']);
    expect(texts(w.received(b, 'chat'))).toEqual([]);
    expect((w.received(c, 'chat')[0] as ChatMessage).channel).toBe('private');
    await w.close();
  });

  it('blocks are two-way and server-enforced; mutes are one-way and silent', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    const b = await w.join('Bob', 1, 10);
    const c = await w.join('Cara', 2, 10);
    await w.moderation.block(w.ctx, b, { target: a });
    expect(w.received(b, 'moderation')[0]).toMatchObject({ action: 'blocked', targetName: 'Alice' });
    w.clearSent();
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: 'from alice' });
    w.chat.handleChat(w.ctx, b, { channel: 'proximity', text: 'from bob' });
    expect(texts(w.received(b, 'chat'))).toEqual(['from bob']);
    expect(texts(w.received(a, 'chat'))).toEqual(['from alice']);
    expect(texts(w.received(c, 'chat'))).toEqual(['from alice', 'from bob']);
    w.chat.handleWhisper(w.ctx, a, { to: b, text: 'let me talk' });
    expect(w.received(a, 'error')[0]).toMatchObject({ code: 'blocked' });
    expect(texts(w.received(b, 'chat'))).toEqual(['from bob']);
    // Persisted relation.
    expect((await w.persistence.relations.list(w.state.players.get(b)!.profileId)).blocked).toEqual([w.state.players.get(a)!.profileId]);
    // Mute: Cara mutes Alice; Alice still sees her own whisper; Cara receives nothing.
    await w.moderation.mute(w.ctx, c, { target: a });
    w.clearSent();
    w.chat.handleWhisper(w.ctx, a, { to: c, text: 'hi cara' });
    expect(texts(w.received(a, 'chat'))).toEqual(['hi cara']);
    expect(texts(w.received(c, 'chat'))).toEqual([]);
    await w.moderation.unmute(w.ctx, c, { target: a });
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: 'again' });
    expect(texts(w.received(c, 'chat'))).toEqual(['again']);
    await w.close();
  });

  it('sanitizes, masks profanity, caps length and rejects duplicates', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: '  what​ the   fuck \u0007' });
    expect(texts(w.received(a, 'chat'))).toEqual(['what the f***']);
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: 'x'.repeat(CONFIG.chat.maxMessageLength + 1) });
    expect(w.received(a, 'error').at(-1)).toMatchObject({ code: 'message_too_long' });
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: 123 as unknown as string });
    expect(w.received(a, 'error').at(-1)).toMatchObject({ code: 'bad_request' });
    w.clock.advance(20_000);
    w.clearSent();
    for (let i = 0; i < 3; i++) {
      w.chat.handleChat(w.ctx, a, { channel: 'global', text: 'buy gold' });
      w.clock.advance(2100);
    }
    expect(texts(w.received(a, 'chat'))).toEqual(['buy gold', 'buy gold']);
    expect(w.received(a, 'rate_limited').length).toBe(1);
    await w.close();
  });

  it('rate-limits chat per player and auto-mutes repeated abuse (persisted sanction)', async () => {
    const w = await makeWorld();
    const a = await w.join('Spammer', 0, 10);
    const b = await w.join('Bystander', 1, 10);
    for (let i = 0; i < 40; i++) w.chat.handleChat(w.ctx, a, { channel: 'global', text: `msg ${i}` });
    const delivered = texts(w.received(b, 'chat'));
    expect(delivered.length).toBe(CONFIG.rateLimits.chat.capacity);
    expect(w.received(a, 'rate_limited').length).toBeGreaterThanOrEqual(CONFIG.moderation.abuseStrikes);
    await new Promise((r) => setTimeout(r, 50)); // sanction write is async
    const pid = w.state.players.get(a)!.profileId;
    expect(w.moderation.chatMutedFor(pid)).toBeGreaterThan(0);
    expect((await w.persistence.sanctions.active(w.clock.t, pid))[0]).toMatchObject({ kind: 'chat_mute', createdBy: 'system' });
    expect(w.received(a, 'notice').some((n) => (n as { code?: string }).code === 'chat_muted')).toBe(true);
    w.clock.advance(60_000);
    w.clearSent();
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: 'am I muted' });
    expect(texts(w.received(b, 'chat'))).toEqual([]);
    w.clock.advance(CONFIG.moderation.autoMuteMs);
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: 'back' });
    expect(texts(w.received(b, 'chat'))).toEqual(['back']);
    await w.close();
  });

  it('reports persist with chat evidence from the reported player', async () => {
    const w = await makeWorld();
    const a = await w.join('Rude', 0, 10);
    const b = await w.join('Victim', 1, 10);
    w.chat.handleWhisper(w.ctx, a, { to: b, text: 'you are dumb' });
    await w.moderation.report(w.ctx, b, { target: a, reason: 'harassment', details: 'kept whispering' });
    const [rep] = await w.persistence.reports.list(5);
    expect(rep).toMatchObject({ reason: 'harassment', details: 'kept whispering', targetProfileId: w.state.players.get(a)!.profileId });
    expect(rep!.evidence.join('\n')).toContain('you are dumb');
    expect(w.received(b, 'moderation')[0]).toMatchObject({ action: 'reported' });
    await w.close();
  });

  it('timed chat-mute sanction expires on time, also after a restart (reloaded from storage on join)', async () => {
    const w = await makeWorld();
    const a = await w.join('Muted', 0, 10);
    const b = await w.join('Listener', 1, 10);
    const pid = w.ctx.getProfile(a)!.id;
    const s = await w.moderation.sanction({ profileId: pid, kind: 'chat_mute', minutes: 2, reason: 'admin test', createdBy: 'admin' });
    expect(s.expiresAt).toBe(w.clock.t + 120_000);
    w.chat.handleChat(w.ctx, a, { channel: 'global', text: 'one' });
    expect(texts(w.received(b, 'chat'))).toEqual([]);
    expect(w.received(a, 'error').at(-1)).toMatchObject({ code: 'forbidden' });

    // "Restart": fresh services on the same storage + clock; the mute is reloaded when the player joins.
    const profile = (await w.persistence.profiles.get(pid))!;
    const w2 = await makeWorld({ persistence: w.persistence, clock: w.clock });
    const a2 = await w2.join('Muted', 0, 10, profile);
    const b2 = await w2.join('Listener', 1, 10);
    w.clock.advance(60_000);
    w2.chat.handleChat(w2.ctx, a2, { channel: 'global', text: 'two' });
    expect(texts(w2.received(b2, 'chat'))).toEqual([]);
    w.clock.advance(60_001);
    w2.chat.handleChat(w2.ctx, a2, { channel: 'global', text: 'three' });
    expect(texts(w2.received(b2, 'chat'))).toEqual(['three']);
    expect(await w2.persistence.sanctions.active(w.clock.t, pid)).toEqual([]);
    await w.close();
  });

  it('block/unblock/mute/unmute by profileId work for offline players; lists carry names', async () => {
    const w = await makeWorld();
    const a = await w.join('Alice', 0, 10);
    let b = await w.join('Bob', 1, 10);
    const bobProfile = w.ctx.getProfile(b)!;
    await w.moderation.block(w.ctx, a, { target: b }); // by session id still works
    await w.moderation.mute(w.ctx, a, { target: b });
    await w.leave(b); // Bob goes offline
    const alice = w.ctx.getProfile(a)!.id;
    expect(await w.moderation.listRelations(alice)).toEqual({ blocked: [{ profileId: bobProfile.id, name: 'Bob' }], muted: [{ profileId: bobProfile.id, name: 'Bob' }] });
    w.clearSent();
    await w.moderation.unblock(w.ctx, a, { profileId: bobProfile.id });
    await w.moderation.unmute(w.ctx, a, { profileId: bobProfile.id });
    expect(w.received(a, 'moderation')).toEqual([
      { action: 'unblocked', targetProfileId: bobProfile.id, targetName: 'Bob' },
      { action: 'unmuted', targetProfileId: bobProfile.id, targetName: 'Bob' },
    ]);
    expect(await w.persistence.relations.list(alice)).toEqual({ blocked: [], muted: [] });
    // Blocking an offline profile by id also works; unknown ids are rejected.
    await w.moderation.block(w.ctx, a, { profileId: bobProfile.id });
    expect((await w.moderation.listRelations(alice)).blocked).toEqual([{ profileId: bobProfile.id, name: 'Bob' }]);
    await w.moderation.block(w.ctx, a, { profileId: 'g_nobody' });
    expect(w.received(a, 'error').at(-1)).toMatchObject({ code: 'not_found' });
    await w.moderation.unblock(w.ctx, a, { profileId: bobProfile.id });
    // Bob returns: his chat reaches Alice again.
    b = await w.join('Bob', 1, 10, (await w.persistence.profiles.get(bobProfile.id))!);
    w.chat.handleChat(w.ctx, b, { channel: 'global', text: 'back again' });
    expect(texts(w.received(a, 'chat'))).toContain('back again');
    await w.close();
  });
});
