/**
 * Block / mute / report, sanctions, text filtering and rate limiting.
 *
 *  - Blocks are two-way delivery filters enforced server-side: neither side
 *    receives the other's proximity/global chat, whispers, reactions or mail
 *    notes. Mutes are one-directional and silent (only the muter stops
 *    receiving). Both persist in `profile_relations`.
 *  - Reports persist with evidence: the recent chat lines (any channel this
 *    room saw) from the reported player, plus explicitly referenced message ids.
 *  - Sanctions (`chat_mute`, `ban`) persist with optional expiry; admins create
 *    them over REST (http/admin.ts); repeated rate-limit abuse creates an
 *    automatic temporary chat mute (CONFIG.moderation).
 */
import { randomUUID } from 'node:crypto';
import { CONFIG, type ChatMessage, type ReportPayload, type ReportReason, type TargetPayload } from '@elsewhere/shared';
import type { PersistenceService, SanctionKind, StoredSanction } from '../persistence/index.js';
import { roomRegistry, type RoomContext, type RoomHooks } from '../rooms/RoomContext.js';
import { RateLimiter } from './rateLimit.js';
import { filterText, sanitizeText } from './text.js';

export { RateLimiter } from './rateLimit.js';

const REPORT_REASONS: readonly ReportReason[] = ['harassment', 'spam', 'inappropriate_name', 'inappropriate_content', 'cheating', 'other'];

export interface EvidenceLine {
  id: string;
  ts: number;
  channel: ChatMessage['channel'];
  fromProfileId: string;
  fromName: string;
  toProfileId?: string;
  text: string;
}

export interface SanctionInput {
  profileId: string;
  kind: SanctionKind;
  /** Minutes; null/undefined = permanent. */
  minutes?: number | null;
  reason: string;
  createdBy: string;
}

export interface ModerationService extends RoomHooks {
  readonly rateLimiter: RateLimiter;
  /** True if either profile blocked the other. */
  isBlockedBetween(profileA: string, profileB: string): boolean;
  /** True if `listener` muted `speaker`. */
  isMutedBy(listenerProfileId: string, speakerProfileId: string): boolean;
  /** Ms remaining on an active chat mute (0 = may chat). */
  chatMutedFor(profileId: string): number;
  isBanned(profileId: string): Promise<boolean>;
  block(ctx: RoomContext, sessionId: string, payload: TargetPayload): Promise<void>;
  unblock(ctx: RoomContext, sessionId: string, payload: TargetPayload): Promise<void>;
  mute(ctx: RoomContext, sessionId: string, payload: TargetPayload): Promise<void>;
  unmute(ctx: RoomContext, sessionId: string, payload: TargetPayload): Promise<void>;
  report(ctx: RoomContext, sessionId: string, payload: ReportPayload): Promise<void>;
  /** Normalize/clean user text (trim, collapse whitespace, strip control/invisible chars, profanity mask). */
  filterText(text: string): string;
  /** Chat service feeds delivered lines here (report evidence ring buffer). */
  recordChat(msg: ChatMessage, toProfileId?: string): void;
  /** WorldRoom calls this on every rate-limit rejection; repeated abuse → automatic chat mute. */
  noteRateLimited(ctx: RoomContext, sessionId: string, action: string): void;
  sanction(input: SanctionInput): Promise<StoredSanction>;
  revokeSanction(id: string): Promise<boolean>;
}

export interface ModerationOptions {
  now?: () => number;
  rateLimiter?: RateLimiter;
}

export function createModeration(persistence: PersistenceService, options: ModerationOptions = {}): ModerationService {
  const now = options.now ?? Date.now;
  const rateLimiter = options.rateLimiter ?? new RateLimiter();
  /** Relation cache for connected profiles (refcounted by session). */
  const rel = new Map<string, { blocked: Set<string>; muted: Set<string>; refs: number }>();
  const chatMutes = new Map<string, number>();
  const strikes = new Map<string, number[]>();
  const evidence: EvidenceLine[] = [];
  const EVIDENCE_BUFFER = 500;

  const relFor = (profileId: string) => {
    let r = rel.get(profileId);
    if (!r) rel.set(profileId, (r = { blocked: new Set(), muted: new Set(), refs: 0 }));
    return r;
  };

  function resolveTarget(ctx: RoomContext, sessionId: string, payload: TargetPayload, type: 'block' | 'unblock' | 'mute' | 'unmute' | 'report') {
    const me = ctx.getProfile(sessionId);
    const target = typeof payload.target === 'string' ? ctx.getPlayer(payload.target) : undefined;
    if (!me) return null;
    if (!target) {
      ctx.error(sessionId, 'not_found', 'That player is not here', type);
      return null;
    }
    if (target.profileId === me.id) {
      ctx.error(sessionId, 'bad_request', 'You cannot do that to yourself', type);
      return null;
    }
    return { me, targetProfileId: target.profileId, targetName: target.name };
  }

  async function setRelation(ctx: RoomContext, sessionId: string, payload: TargetPayload, kind: 'block' | 'mute', on: boolean): Promise<void> {
    const type = on ? kind : kind === 'block' ? 'unblock' : 'unmute';
    const r = resolveTarget(ctx, sessionId, payload, type);
    if (!r) return;
    const cache = relFor(r.me.id);
    const set = kind === 'block' ? cache.blocked : cache.muted;
    const list = kind === 'block' ? r.me.blocked : r.me.muted;
    if (on) {
      set.add(r.targetProfileId);
      if (!list.includes(r.targetProfileId)) list.push(r.targetProfileId);
      await persistence.relations.add(r.me.id, r.targetProfileId, kind, now());
    } else {
      set.delete(r.targetProfileId);
      const i = list.indexOf(r.targetProfileId);
      if (i >= 0) list.splice(i, 1);
      await persistence.relations.remove(r.me.id, r.targetProfileId, kind);
    }
    const action = (on ? (kind === 'block' ? 'blocked' : 'muted') : kind === 'block' ? 'unblocked' : 'unmuted') as 'blocked' | 'unblocked' | 'muted' | 'unmuted';
    ctx.send(sessionId, 'moderation', { action, targetProfileId: r.targetProfileId, targetName: r.targetName });
  }

  function chatMutedFor(profileId: string): number {
    const until = chatMutes.get(profileId);
    if (until === undefined) return 0;
    const left = until - now();
    if (left <= 0) {
      chatMutes.delete(profileId);
      return 0;
    }
    return left;
  }

  async function refreshSanctions(profileId: string): Promise<StoredSanction[]> {
    const active = await persistence.sanctions.active(now(), profileId);
    const mute = active.filter((s) => s.kind === 'chat_mute');
    if (mute.length) chatMutes.set(profileId, Math.max(...mute.map((s) => s.expiresAt ?? Number.MAX_SAFE_INTEGER)));
    else chatMutes.delete(profileId);
    return active;
  }

  const service: ModerationService = {
    rateLimiter,
    isBlockedBetween(a, b) {
      return (rel.get(a)?.blocked.has(b) ?? false) || (rel.get(b)?.blocked.has(a) ?? false);
    },
    isMutedBy(listener, speaker) {
      return rel.get(listener)?.muted.has(speaker) ?? false;
    },
    chatMutedFor,
    async isBanned(profileId) {
      return (await persistence.sanctions.active(now(), profileId)).some((s) => s.kind === 'ban');
    },
    block: (ctx, sid, p) => setRelation(ctx, sid, p, 'block', true),
    unblock: (ctx, sid, p) => setRelation(ctx, sid, p, 'block', false),
    mute: (ctx, sid, p) => setRelation(ctx, sid, p, 'mute', true),
    unmute: (ctx, sid, p) => setRelation(ctx, sid, p, 'mute', false),

    async report(ctx, sessionId, payload) {
      const r = resolveTarget(ctx, sessionId, payload, 'report');
      if (!r) return;
      const reason: ReportReason = REPORT_REASONS.includes(payload.reason) ? payload.reason : 'other';
      const details = sanitizeText(payload.details).slice(0, 500);
      const wanted = new Set(Array.isArray(payload.messageIds) ? payload.messageIds.filter((x): x is string => typeof x === 'string').slice(0, 20) : []);
      const lines = evidence
        .filter((l) => wanted.has(l.id) || l.fromProfileId === r.targetProfileId)
        .slice(-CONFIG.moderation.evidenceLines)
        .map((l) => `[${new Date(l.ts).toISOString()}] (${l.channel}) ${l.fromName} <${l.fromProfileId}>${l.toProfileId ? ` → <${l.toProfileId}>` : ''}: ${l.text}`);
      await persistence.reports.add({
        id: `rep_${randomUUID()}`,
        ts: now(),
        reporterProfileId: r.me.id,
        targetProfileId: r.targetProfileId,
        reason,
        ...(details ? { details } : {}),
        evidence: lines,
        status: 'open',
      });
      ctx.send(sessionId, 'moderation', { action: 'reported', targetProfileId: r.targetProfileId, targetName: r.targetName });
    },

    filterText: (text) => filterText(text),

    recordChat(msg, toProfileId) {
      if (msg.channel === 'system') return;
      const line: EvidenceLine = { id: msg.id, ts: msg.ts, channel: msg.channel, fromProfileId: msg.fromProfileId, fromName: msg.fromName, text: msg.text };
      if (toProfileId) line.toProfileId = toProfileId;
      evidence.push(line);
      if (evidence.length > EVIDENCE_BUFFER) evidence.splice(0, evidence.length - EVIDENCE_BUFFER);
    },

    noteRateLimited(ctx, sessionId, action) {
      if (action === 'move') return;
      const profile = ctx.getProfile(sessionId);
      if (!profile) return;
      const t = now();
      const arr = (strikes.get(profile.id) ?? []).filter((x) => t - x < CONFIG.moderation.abuseWindowMs);
      arr.push(t);
      strikes.set(profile.id, arr);
      if (arr.length >= CONFIG.moderation.abuseStrikes && chatMutedFor(profile.id) === 0) {
        strikes.delete(profile.id);
        const minutes = CONFIG.moderation.autoMuteMs / 60_000;
        void service
          .sanction({ profileId: profile.id, kind: 'chat_mute', minutes, reason: `auto: repeated rate-limit abuse (${action})`, createdBy: 'system' })
          .then(() => ctx.notice(sessionId, { level: 'warning', code: 'chat_muted', text: `You're sending messages too quickly. Chat is paused for ${minutes} minutes.` }))
          .catch((err) => console.error('[moderation] auto-mute failed', err));
      }
    },

    async sanction(input) {
      const t = now();
      const minutes = input.minutes === null || input.minutes === undefined ? null : Math.max(1, Math.min(60 * 24 * 365, input.minutes));
      const s: StoredSanction = {
        id: `san_${randomUUID()}`,
        profileId: input.profileId,
        kind: input.kind,
        reason: sanitizeText(input.reason).slice(0, 300) || 'unspecified',
        createdAt: t,
        expiresAt: minutes === null ? null : t + minutes * 60_000,
        createdBy: input.createdBy,
        revokedAt: null,
      };
      await persistence.sanctions.add(s);
      if (s.kind === 'chat_mute') chatMutes.set(s.profileId, Math.max(chatMutes.get(s.profileId) ?? 0, s.expiresAt ?? Number.MAX_SAFE_INTEGER));
      if (s.kind === 'ban') {
        for (const ctx of roomRegistry) {
          const sid = ctx.sessionForProfile(s.profileId);
          if (sid) ctx.kick(sid, 'banned');
        }
      }
      return s;
    },

    async revokeSanction(id) {
      const ok = await persistence.sanctions.revoke(id, now());
      if (ok) {
        // Re-derive caches for anyone online.
        for (const profileId of [...chatMutes.keys()]) await refreshSanctions(profileId);
      }
      return ok;
    },

    async onPlayerPreJoin(ctx, sessionId) {
      const p = ctx.getProfile(sessionId);
      if (!p) return;
      const r = relFor(p.id);
      r.refs += 1;
      r.blocked = new Set(p.blocked);
      r.muted = new Set(p.muted);
      await refreshSanctions(p.id);
    },
    onPlayerLeave(ctx, sessionId) {
      rateLimiter.forget(sessionId);
      const p = ctx.getProfile(sessionId);
      if (!p) return;
      const r = rel.get(p.id);
      if (r && --r.refs <= 0) {
        rel.delete(p.id);
        chatMutes.delete(p.id);
      }
    },
  };
  return service;
}
