/**
 * The persistent world room (one instance ≈ one shard of The Commons).
 *
 * Foundation responsibilities (owned here):
 *  - join/leave/reconnect, profile resolution, spawn, welcome payload
 *  - authoritative movement: speed budget + shared collision (resolveMovement)
 *  - generic validation for interactions (exists, in range, rate limit)
 *  - emotes, reactions, appearance/name updates
 *  - routing every other message to the service seams (chat, moderation, …)
 *  - profile lifecycle: resume at last position, first-visit / return memory,
 *    periodic autosave, save on leave and on dispose (graceful shutdown)
 */
import { Room, type Client } from '@colyseus/core';
import {
  C2S,
  CONFIG,
  S2C,
  SYNCED_INTERACTABLES,
  dist,
  findNearestWalkable,
  getInteractable,
  groundHeight,
  isEmote,
  isFiniteNumber,
  isLocomotionAnim,
  isReaction,
  locationAt,
  pickSpawnPoint,
  resolveMovement,
  sameSpace,
  sanitizeAppearance,
  validateDisplayName,
  wrapAngle,
  type C2SPayloads,
  type C2SType,
  type ErrorCode,
  type JoinOptions,
  type LocationId,
  type RateLimitAction,
  type S2CPayloads,
  type S2CType,
  worldTimeAt,
  isWalkable,
} from '@elsewhere/shared';
import { newGuestProfile, toProfileSummary } from '../auth/index.js';
import { ENV } from '../env.js';
import type { StoredProfile } from '../persistence/index.js';
import { services, type ServerServices } from '../services.js';
import { applyEmote } from './emotes.js';
import { roomRegistry, type RoomContext, type TimerHandle } from './RoomContext.js';
import { ObjectState, PlayerState, WorldState } from './schema.js';

interface ClientAuth {
  profile: StoredProfile;
}

interface MoveTrack {
  lastAt: number;
  /** Distance the player may still travel (refills at max speed, capped). */
  budget: number;
  seq: number;
}

const MOVE_BUDGET_CAP = CONFIG.movement.runSpeed * 0.6 + CONFIG.movement.distanceSlack;
const AUTOSAVE_MS = 60_000;
/** Join-time bookkeeping (memory, collective) waits this long so the first state sync is not delayed. */
export const JOIN_SETTLE_MS = 1500;
/** Moved players' positions are persisted this often (a hard kill loses at most this much movement). */
export const POSITION_SAVE_MS = 2000;
/** A client's resume hint is only used within this distance of the saved position. */
const RESUME_HINT_MAX_M = 3;

/**
 * Where a returning player appears. The SAVED position is authoritative; the
 * client's `resume` hint (untrusted) is only a tie-breaker when it is close to
 * the saved spot and walkable.
 */
export function resumePosition(saved: { x: number; z: number } | null | undefined, hint?: unknown): { x: number; z: number } | null {
  if (!saved || !isFiniteNumber(saved.x) || !isFiniteNumber(saved.z)) return null;
  const h = hint as { x?: unknown; z?: unknown } | undefined;
  if (h && isFiniteNumber(h.x) && isFiniteNumber(h.z) && Math.hypot(h.x - saved.x, h.z - saved.z) <= RESUME_HINT_MAX_M && isWalkable({ x: h.x, z: h.z }) && sameSpace(saved, { x: h.x, z: h.z })) {
    return { x: h.x, z: h.z };
  }
  return isWalkable(saved) ? { x: saved.x, z: saved.z } : findNearestWalkable(saved, CONFIG.movement.playerRadius, 4);
}
/** A join after this much absence is remembered as a return. */
const RETURN_AFTER_MS = 60 * 60_000;
/** Close code sent on admin kick / ban (4000-4999 are application codes). */
export const KICK_CLOSE_CODE = 4003;

export class WorldRoom extends Room<{ state: WorldState }> {
  override maxClients = CONFIG.network.maxClientsPerRoom;
  override state = new WorldState();

  private svc!: ServerServices;
  private ctx!: RoomContext;
  private moves = new Map<string, MoveTrack>();
  private profiles = new Map<string, StoredProfile>();
  private joinCounter = 0;
  private joinedAt = new Map<string, number>();
  private kicked = new Set<string>();
  /** Sessions that moved since the last position flush. */
  private dirtyPos = new Set<string>();
  private animTimers = new Map<string, TimerHandle>();

  override async onCreate(): Promise<void> {
    this.svc = services();
    this.ctx = this.createContext();
    this.setPatchRate(1000 / CONFIG.network.patchRateHz);

    const facts = this.svc.collective.facts();
    this.state.clockEpoch = facts.clockEpochMs;
    this.state.dayLengthMs = ENV.dayLengthMs;
    for (const it of SYNCED_INTERACTABLES) {
      this.state.objects.set(it.id, new ObjectState({ id: it.id, active: it.kind === 'pickup', updatedAt: Date.now() }));
    }

    this.registerMessages();
    this.setSimulationInterval((dt) => {
      for (const h of this.svc.hooks) {
        try {
          h.tick?.(this.ctx, dt);
        } catch (err) {
          console.error('[WorldRoom] tick hook failed', err);
        }
      }
    }, 1000 / CONFIG.network.tickRateHz);
    this.clock.setInterval(() => void this.saveAllProfiles(), AUTOSAVE_MS);
    this.clock.setInterval(() => void this.flushPositions(), POSITION_SAVE_MS);

    for (const h of this.svc.hooks) await h.onRoomCreate?.(this.ctx);
    roomRegistry.add(this.ctx);
  }

  override async onAuth(_client: Client, options: Partial<JoinOptions> | undefined): Promise<ClientAuth> {
    const opts = options ?? {};
    if (opts.protocolVersion !== CONFIG.protocolVersion) {
      throw new Error(`protocol_mismatch: server ${CONFIG.protocolVersion}, client ${String(opts.protocolVersion)}`);
    }
    const identity = await this.svc.auth.verify(typeof opts.token === 'string' ? opts.token : undefined);
    let profile = identity ? await this.svc.persistence.profiles.get(identity.profileId) : null;
    if (profile && (await this.svc.moderation.isBanned(profile.id))) throw new Error('forbidden: this account is suspended');
    if (!profile) {
      // No/invalid token: ephemeral guest (not persisted beyond this process).
      profile = newGuestProfile(opts.name, opts.appearance);
      await this.svc.persistence.profiles.save(profile);
    } else if (profile.kind === 'guest') {
      // Guests may refresh name/appearance at join time.
      const v = validateDisplayName(opts.name);
      if (v.ok) profile.displayName = v.name;
      if (opts.appearance) profile.appearance = sanitizeAppearance(opts.appearance);
    }
    return { profile };
  }

  override async onJoin(client: Client, options: Partial<JoinOptions> | undefined, auth?: ClientAuth): Promise<void> {
    const profile = (client.auth as ClientAuth | undefined)?.profile ?? auth?.profile;
    if (!profile) throw new Error('unauthorized');
    const firstVisit = profile.visits === 0;
    const returning = !firstVisit && Date.now() - profile.lastSeenAt > RETURN_AFTER_MS;
    profile.visits += 1;
    profile.lastSeenAt = Date.now();
    profile.inventory ??= [];
    profile.stats ??= {};
    await this.svc.persistence.profiles.save(profile);
    this.profiles.set(client.sessionId, profile);
    this.joinedAt.set(client.sessionId, Date.now());

    const spawn = pickSpawnPoint(this.joinCounter++);
    // Returning players resume where they left (if that spot is still walkable).
    const pos = resumePosition(profile.lastPosition, options?.resume) ?? findNearestWalkable(spawn.position) ?? spawn.position;
    const player = new PlayerState({
      id: client.sessionId,
      profileId: profile.id,
      name: profile.displayName,
      appearance: JSON.stringify(profile.appearance),
      x: pos.x,
      y: groundHeight(pos.x, pos.z),
      z: pos.z,
      rot: spawn.yaw,
      anim: 'idle',
      location: locationAt(pos)?.id ?? '',
    });
    this.state.players.set(client.sessionId, player);
    this.moves.set(client.sessionId, { lastAt: Date.now(), budget: MOVE_BUDGET_CAP, seq: 0 });

    for (const h of this.svc.hooks) await h.onPlayerPreJoin?.(this.ctx, client.sessionId);
    const facts = this.svc.collective.facts();
    const portal = this.state.objects.get('portal_arch');
    const relations = await this.svc.moderation.listRelations(profile.id);
    this.sendTo(client.sessionId, S2C.welcome, {
      sessionId: client.sessionId,
      serverTime: Date.now(),
      clockEpoch: this.state.clockEpoch,
      dayLengthMs: this.state.dayLengthMs,
      profile: toProfileSummary(profile),
      blocked: [...profile.blocked],
      muted: [...profile.muted],
      blockedProfiles: relations.blocked,
      mutedProfiles: relations.muted,
      recentChat: this.svc.chat.recent(profile.id, this.roomId),
      world: {
        fountainStage: facts.fountainStage,
        fountainContributors: facts.fountainContributors,
        portalAwake: portal?.active ?? false,
        portalAwakenings: facts.portalAwakenings,
        portalAwakeUntil: portal?.active ? (facts.portalAwakeUntil ?? 0) : 0,
      },
    });
    for (const h of this.svc.hooks) await h.onPlayerJoin?.(this.ctx, client.sessionId);

    // Memory/collective bookkeeping must not delay the join (state sync starts after the JOIN_ROOM round trip).
    const actor = { profileId: profile.id, name: profile.displayName };
    const sid = client.sessionId;
    const location = player.location;
    // Deferred: a client only receives its first full state after acking JOIN_ROOM; keep that window quiet.
    this.ctx.setTimeout(() => void bookkeeping().catch((err) => console.error("[WorldRoom] join bookkeeping failed", err)), JOIN_SETTLE_MS);
    const bookkeeping = async () => {
      if (firstVisit) {
        await this.svc.memory.record({ kind: 'player_first_visit', actors: [actor], ...(location ? { locationId: location as LocationId } : {}), significance: 1 });
        await this.svc.collective.signal(this.ctx, { type: 'first_visit', sessionId: sid, profileId: profile.id });
      } else if (returning) {
        await this.svc.memory.record({ kind: 'player_returned', actors: [actor], significance: 0, data: { visits: profile.visits } });
      }
    };
  }

  override async onDrop(client: Client): Promise<void> {
    // Kicked/banned sessions get no reconnection grace: onLeave runs right away.
    if (this.kicked.delete(client.sessionId)) return;
    // Keep the player's body in the world briefly so a flaky connection can resume.
    const player = this.state.players.get(client.sessionId);
    if (player) player.anim = 'idle';
    // Rejects (e.g. "not joined" when the socket drops mid-join, or on timeout) — never let it go unhandled.
    this.allowReconnection(client, CONFIG.network.reconnectGraceSeconds).catch(() => undefined);
  }

  override async onReconnect(client: Client): Promise<void> {
    const t = this.moves.get(client.sessionId);
    if (t) t.lastAt = Date.now();
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const sid = client.sessionId;
    for (const h of this.svc.hooks) await h.onPlayerLeave?.(this.ctx, sid);
    await this.saveProfile(sid);
    this.joinedAt.delete(sid);
    this.kicked.delete(sid);
    this.animTimers.get(sid)?.clear();
    this.animTimers.delete(sid);
    this.state.players.delete(sid);
    this.moves.delete(sid);
    this.profiles.delete(sid);
    void code; // consented vs. dropped is already distinguished by onDrop
  }

  override async onDispose(): Promise<void> {
    roomRegistry.delete(this.ctx);
    await this.saveAllProfiles();
    for (const h of this.svc.hooks) await h.onRoomDispose?.(this.ctx);
  }

  /** Copy live state (position, time online) into the stored profile and persist it. */
  private async saveProfile(sid: string): Promise<void> {
    const profile = this.profiles.get(sid);
    if (!profile) return;
    const p = this.state.players.get(sid);
    const t = Date.now();
    if (p) profile.lastPosition = { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 };
    const since = this.joinedAt.get(sid);
    if (since) {
      profile.stats.timeOnlineMs = (profile.stats.timeOnlineMs ?? 0) + (t - since);
      this.joinedAt.set(sid, t);
    }
    profile.lastSeenAt = t;
    try {
      await this.svc.persistence.profiles.save(profile);
    } catch (err) {
      console.error('[WorldRoom] profile save failed', profile.id, err);
    }
  }

  /** Cheap, frequent position persistence (survives a hard kill): one UPDATE per moved player. */
  private async flushPositions(): Promise<void> {
    if (!this.dirtyPos.size) return;
    const sids = [...this.dirtyPos];
    this.dirtyPos.clear();
    const t = Date.now();
    await Promise.all(
      sids.map(async (sid) => {
        const profile = this.profiles.get(sid);
        const p = this.state.players.get(sid);
        if (!profile || !p) return;
        profile.lastPosition = { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 };
        profile.lastSeenAt = t;
        try {
          await this.svc.persistence.profiles.savePosition(profile.id, profile.lastPosition, t);
        } catch (err) {
          console.error('[WorldRoom] position save failed', profile.id, err);
        }
      }),
    );
  }

  private async saveAllProfiles(): Promise<void> {
    await Promise.all([...this.profiles.keys()].map((sid) => this.saveProfile(sid)));
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private on<T extends C2SType>(type: T, limit: RateLimitAction | null, handler: (sessionId: string, payload: C2SPayloads[T]) => void | Promise<void>): void {
    this.onMessage(type, (client: Client, raw: unknown) => {
      const sid = client.sessionId;
      if (!this.state.players.has(sid)) return;
      if (limit) {
        const wait = this.svc.moderation.rateLimiter.take(sid, limit);
        if (wait > 0) {
          if (limit !== 'move') {
            this.sendTo(sid, S2C.rateLimited, { action: type, retryInMs: wait });
            this.svc.moderation.noteRateLimited(this.ctx, sid, type);
          }
          return;
        }
      }
      // Payloads are plain JSON objects; anything else is coerced to {} and fails per-field validation.
      const payload = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as C2SPayloads[T];
      Promise.resolve()
        .then(() => handler(sid, payload))
        .catch((err: unknown) => {
          console.error(`[WorldRoom] ${type} handler failed`, err);
          this.ctx.error(sid, 'internal', 'Something went wrong', type);
        });
    });
  }

  private registerMessages(): void {
    const s = this.svc;
    this.on(C2S.move, 'move', (sid, m) => this.handleMove(sid, m));
    this.on(C2S.stand, null, (sid) => s.interactions.stand(this.ctx, sid));
    this.on(C2S.emote, 'emote', (sid, m) => this.handleEmote(sid, m.emote));
    this.on(C2S.reaction, 'reaction', (sid, m) => {
      if (!isReaction(m.emoji)) return this.ctx.error(sid, 'bad_request', 'Unknown reaction', C2S.reaction);
      const me = this.state.players.get(sid)!;
      const targetPlayer = typeof m.target === 'string' ? this.state.players.get(m.target) : undefined;
      if (targetPlayer && s.moderation.isBlockedBetween(me.profileId, targetPlayer.profileId)) return this.ctx.error(sid, 'blocked', 'You cannot react to that player', C2S.reaction);
      const payload: S2CPayloads['reaction'] = { sessionId: sid, emoji: m.emoji, ts: Date.now() };
      if (targetPlayer) payload.target = targetPlayer.id;
      this.ctx.broadcast(S2C.reaction, payload, {
        filter: (to) => {
          const l = this.state.players.get(to);
          return !!l && (to === sid || (!s.moderation.isBlockedBetween(l.profileId, me.profileId) && !s.moderation.isMutedBy(l.profileId, me.profileId)));
        },
      });
    });
    this.on(C2S.chat, null, (sid, m) => s.chat.handleChat(this.ctx, sid, m));
    this.on(C2S.whisper, null, (sid, m) => s.chat.handleWhisper(this.ctx, sid, m));
    this.on(C2S.typing, null, (sid, m) => s.chat.handleTyping(this.ctx, sid, m));
    this.on(C2S.interact, 'interact', (sid, m) => this.handleInteract(sid, m));
    this.on(C2S.dropItem, 'interact', (sid) => s.interactions.dropItem(this.ctx, sid));
    this.on(C2S.mailSend, 'mail', (sid, m) => s.interactions.mailSend(this.ctx, sid, m));
    this.on(C2S.mailRead, null, (sid, m) => s.interactions.mailRead(this.ctx, sid, m));
    this.on(C2S.updateProfile, 'appearance', (sid, m) => this.handleUpdateProfile(sid, m));
    this.on(C2S.block, 'social', (sid, m) => s.moderation.block(this.ctx, sid, m));
    this.on(C2S.unblock, 'social', (sid, m) => s.moderation.unblock(this.ctx, sid, m));
    this.on(C2S.mute, 'social', (sid, m) => s.moderation.mute(this.ctx, sid, m));
    this.on(C2S.unmute, 'social', (sid, m) => s.moderation.unmute(this.ctx, sid, m));
    this.on(C2S.report, 'report', (sid, m) => s.moderation.report(this.ctx, sid, m));
    // Building rate-limits per profile inside the service (survives reconnects).
    this.on(C2S.buildPlace, null, (sid, m) => s.building.place(this.ctx, sid, m));
    this.on(C2S.buildRemove, null, (sid, m) => s.building.remove(this.ctx, sid, m));
    // Building activities (server/src/activities): actions + piano notes, each with its own rate limit.
    this.on(C2S.activity, 'activity', (sid, m) => s.activities.handle(this.ctx, sid, m));
    this.on(C2S.pianoNote, 'piano', (sid, m) => s.activities.pianoNote(this.ctx, sid, m));
    this.on(C2S.unstuck, 'unstuck', (sid) => {
      if (this.state.players.get(sid)?.seat) s.interactions.stand(this.ctx, sid);
      s.building.unstuck(this.ctx, sid);
    });
  }

  private handleMove(sid: string, m: C2SPayloads['move']): void {
    const p = this.state.players.get(sid);
    const track = this.moves.get(sid);
    if (!p || !track) return;
    if (!isFiniteNumber(m.x) || !isFiniteNumber(m.z) || !isFiniteNumber(m.rot)) return;
    const seq = isFiniteNumber(m.seq) ? m.seq : track.seq + 1;
    if (seq <= track.seq) return; // stale / reordered
    track.seq = seq;

    if (p.seat) {
      // Seated players must `stand` first; tell the client where it really is.
      this.sendTo(sid, S2C.correction, { x: p.x, z: p.z, y: p.y, seq, reason: 'seated' });
      return;
    }

    const now = Date.now();
    const dt = Math.min(1, Math.max(0, (now - track.lastAt) / 1000));
    track.lastAt = now;
    track.budget = Math.min(MOVE_BUDGET_CAP, track.budget + CONFIG.movement.runSpeed * CONFIG.movement.speedTolerance * dt);

    const from = { x: p.x, z: p.z };
    const claimed = { x: m.x, z: m.z };
    let target = claimed;
    const wanted = dist(from, claimed);
    let reason: 'speed' | 'collision' = 'collision';
    if (wanted > track.budget) {
      const k = track.budget / wanted;
      target = { x: from.x + (claimed.x - from.x) * k, z: from.z + (claimed.z - from.z) * k };
      reason = 'speed';
    }
    const resolved = resolveMovement(from, target, CONFIG.movement.playerRadius);
    track.budget = Math.max(0, track.budget - dist(from, resolved));

    p.x = resolved.x;
    p.z = resolved.z;
    p.y = groundHeight(resolved.x, resolved.z);
    p.rot = wrapAngle(m.rot);
    const anim = isLocomotionAnim(m.anim) ? m.anim : 'idle';
    // A looping emote (dance) persists until the player actually moves.
    if (!((p.anim === 'dance' || p.anim === 'wave') && anim === 'idle')) p.anim = anim;
    const loc = locationAt(resolved)?.id ?? '';
    if (p.location !== loc) p.location = loc;
    this.dirtyPos.add(sid);

    if (dist(resolved, claimed) > CONFIG.movement.correctionThreshold) {
      this.sendTo(sid, S2C.correction, { x: p.x, z: p.z, y: p.y, seq, reason });
    }
  }

  private handleEmote(sid: string, emote: unknown): void {
    applyEmote(this.ctx, sid, emote, this.animTimers);
  }

  private async handleInteract(sid: string, m: C2SPayloads['interact']): Promise<void> {
    const p = this.state.players.get(sid);
    if (!p) return;
    const target = typeof m.id === 'string' ? getInteractable(m.id) : undefined;
    if (!target) {
      this.sendTo(sid, S2C.interactResult, { id: String(m.id), ok: false, error: 'not_found' });
      return;
    }
    const range = (target.radius ?? CONFIG.interaction.radius) + CONFIG.interaction.serverSlack;
    // No interacting through walls: indoor things need you indoors in the same building (doors: either side).
    if (dist({ x: p.x, z: p.z }, target.position) > range || !sameSpace({ x: p.x, z: p.z }, target.position, target.kind === 'door')) {
      if (process.env.ELSEWHERE_DEBUG) console.log(`[WorldRoom] too_far ${p.name} ${target.id} player=(${p.x.toFixed(2)},${p.z.toFixed(2)}) target=(${target.position.x.toFixed(2)},${target.position.z.toFixed(2)}) d=${dist({ x: p.x, z: p.z }, target.position).toFixed(2)} range=${range.toFixed(2)}`);
      this.sendTo(sid, S2C.interactResult, { id: target.id, ok: false, error: 'too_far' });
      return;
    }
    const result = target.kind === 'station' || target.kind === 'keeper' ? await this.svc.activities.interact(this.ctx, sid, target) : await this.svc.interactions.interact(this.ctx, sid, target, m);
    this.sendTo(sid, S2C.interactResult, result);
  }

  private async handleUpdateProfile(sid: string, m: C2SPayloads['update_profile']): Promise<void> {
    const p = this.state.players.get(sid);
    const profile = this.profiles.get(sid);
    if (!p || !profile) return;
    if (m.name !== undefined) {
      const v = validateDisplayName(m.name);
      if (!v.ok) return this.ctx.error(sid, 'invalid_name', `Name rejected: ${v.reason}`, C2S.updateProfile);
      profile.displayName = v.name;
      p.name = v.name;
    }
    if (m.appearance !== undefined) {
      profile.appearance = sanitizeAppearance(m.appearance);
      p.appearance = JSON.stringify(profile.appearance);
    }
    await this.svc.persistence.profiles.save(profile);
    this.sendTo(sid, S2C.profile, toProfileSummary(profile));
  }

  // -------------------------------------------------------------------------
  // Context for services
  // -------------------------------------------------------------------------

  private sendTo<T extends S2CType>(sessionId: string, type: T, payload: S2CPayloads[T]): void {
    this.clients.get(sessionId)?.send(type, payload);
  }

  private createContext(): RoomContext {
    const room = this;
    return {
      get roomId() {
        return room.roomId;
      },
      state: room.state,
      now: () => Date.now(),
      worldTime: () => worldTimeAt(Date.now(), { epochMs: room.state.clockEpoch, dayLengthMs: room.state.dayLengthMs }),
      getPlayer: (id) => room.state.players.get(id),
      getObject: (id) => room.state.objects.get(id),
      getProfile: (id) => room.profiles.get(id),
      saveProfile: async (id) => {
        const p = room.profiles.get(id);
        if (!p) return;
        try {
          await room.svc.persistence.profiles.save(p);
        } catch (err) {
          console.error('[WorldRoom] profile save failed', p.id, err);
        }
      },
      sessionForProfile: (profileId) => {
        for (const [sid, p] of room.profiles) if (p.id === profileId) return sid;
        return undefined;
      },
      kick: (sid, reason) => {
        const c = room.clients.getById(sid);
        if (!c) return;
        room.kicked.add(sid);
        c.send(S2C.notice, { level: 'error', code: 'kicked', text: reason === 'banned' ? 'You have been removed from the island.' : 'You have been disconnected by a moderator.' });
        c.leave(KICK_CLOSE_CODE, reason);
      },
      sessionIds: () => [...room.state.players.keys()],
      send: (sid, type, payload) => room.sendTo(sid, type, payload),
      broadcast: (type, payload, options) => {
        for (const c of room.clients) {
          if (options?.except === c.sessionId) continue;
          if (options?.filter && !options.filter(c.sessionId)) continue;
          c.send(type, payload);
        }
      },
      notice: (sid, notice) => room.sendTo(sid, S2C.notice, notice),
      error: (sid, code: ErrorCode, message, inResponseTo) => {
        const payload: S2CPayloads['error'] = { code, message };
        if (inResponseTo) payload.inResponseTo = inResponseTo;
        room.sendTo(sid, S2C.error, payload);
      },
      setTimeout: (fn, ms) => {
        const d = room.clock.setTimeout(fn, ms);
        return { clear: () => d.clear() };
      },
      teleport: (sid, x, z, reason = 'teleport') => {
        const p = room.state.players.get(sid);
        if (!p) return;
        p.x = x;
        p.z = z;
        p.y = groundHeight(x, z);
        const t = room.moves.get(sid);
        room.sendTo(sid, S2C.correction, { x, z, y: p.y, seq: t?.seq ?? 0, reason });
      },
    };
  }
}

