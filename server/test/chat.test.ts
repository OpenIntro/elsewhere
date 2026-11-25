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
});
