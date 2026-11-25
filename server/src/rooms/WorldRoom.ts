/**
 * The persistent world room (one instance ≈ one shard of The Commons).
 *
 * Foundation responsibilities (owned here):
 *  - join/leave/reconnect, profile resolution, spawn, welcome payload
 *  - authoritative movement: speed budget + shared collision (resolveMovement)
 *  - generic validation for interactions (exists, in range, rate limit)
 *  - emotes, reactions, appearance/name updates
 *  - routing every other message to the service seams (chat, moderation, …)
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
  sanitizeAppearance,
  validateDisplayName,
  wrapAngle,
  type C2SPayloads,
  type C2SType,
  type ErrorCode,
  type JoinOptions,
  type RateLimitAction,
  type S2CPayloads,
  type S2CType,
} from '@elsewhere/shared';
import { newGuestProfile, toProfileSummary } from '../auth/index.js';
import { ENV } from '../env.js';
import type { StoredProfile } from '../persistence/index.js';
import { services, type ServerServices } from '../services.js';
import type { RoomContext, TimerHandle } from './RoomContext.js';
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

export class WorldRoom extends Room<{ state: WorldState }> {
  override maxClients = CONFIG.network.maxClientsPerRoom;
  override state = new WorldState();

  private svc!: ServerServices;
  private ctx!: RoomContext;
  private moves = new Map<string, MoveTrack>();
  private profiles = new Map<string, StoredProfile>();
  private joinCounter = 0;
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
      for (const h of this.svc.hooks) h.tick?.(this.ctx, dt);
    }, 1000 / CONFIG.network.tickRateHz);

    for (const h of this.svc.hooks) await h.onRoomCreate?.(this.ctx);
  }

  override async onAuth(_client: Client, options: Partial<JoinOptions> | undefined): Promise<ClientAuth> {
    const opts = options ?? {};
    if (opts.protocolVersion !== CONFIG.protocolVersion) {
      throw new Error(`protocol_mismatch: server ${CONFIG.protocolVersion}, client ${String(opts.protocolVersion)}`);
    }
    const identity = await this.svc.auth.verify(typeof opts.token === 'string' ? opts.token : undefined);
    let profile = identity ? await this.svc.persistence.profiles.get(identity.profileId) : null;
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

  override async onJoin(client: Client, _options: unknown, auth?: ClientAuth): Promise<void> {
    const profile = (client.auth as ClientAuth | undefined)?.profile ?? auth?.profile;
    if (!profile) throw new Error('unauthorized');
    profile.visits += 1;
    profile.lastSeenAt = Date.now();
    await this.svc.persistence.profiles.save(profile);
    this.profiles.set(client.sessionId, profile);

    const spawn = pickSpawnPoint(this.joinCounter++);
    const pos = findNearestWalkable(spawn.position) ?? spawn.position;
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

    const facts = this.svc.collective.facts();
    this.sendTo(client.sessionId, S2C.welcome, {
      sessionId: client.sessionId,
      serverTime: Date.now(),
      clockEpoch: this.state.clockEpoch,
      dayLengthMs: this.state.dayLengthMs,
      profile: toProfileSummary(profile),
      blocked: [...profile.blocked],
      muted: [...profile.muted],
      recentChat: this.svc.chat.recent(),
      world: {
        fountainStage: facts.fountainStage,
        fountainContributors: facts.fountainContributors,
        portalAwake: this.state.objects.get('portal_arch')?.active ?? false,
      },
    });
    for (const h of this.svc.hooks) await h.onPlayerJoin?.(this.ctx, client.sessionId);
  }

  override async onDrop(client: Client): Promise<void> {
    // Keep the player's body in the world briefly so a flaky connection can resume.
    const player = this.state.players.get(client.sessionId);
    if (player) player.anim = 'idle';
    this.allowReconnection(client, CONFIG.network.reconnectGraceSeconds);
  }

  override async onReconnect(client: Client): Promise<void> {
    const t = this.moves.get(client.sessionId);
    if (t) t.lastAt = Date.now();
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const sid = client.sessionId;
    for (const h of this.svc.hooks) await h.onPlayerLeave?.(this.ctx, sid);
    const profile = this.profiles.get(sid);
    if (profile) {
      profile.lastSeenAt = Date.now();
      await this.svc.persistence.profiles.save(profile);
    }
    this.animTimers.get(sid)?.clear();
    this.animTimers.delete(sid);
    this.state.players.delete(sid);
    this.moves.delete(sid);
    this.profiles.delete(sid);
    void code; // consented vs. dropped is already distinguished by onDrop
  }

  override async onDispose(): Promise<void> {
    for (const h of this.svc.hooks) await h.onRoomDispose?.(this.ctx);
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
          if (limit !== 'move') this.sendTo(sid, S2C.rateLimited, { action: type, retryInMs: wait });
          return;
        }
      }
      const payload = (raw && typeof raw === 'object' ? raw : {}) as C2SPayloads[T];
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
      const target = typeof m.target === 'string' && this.state.players.has(m.target) ? m.target : undefined;
      const payload: S2CPayloads['reaction'] = { sessionId: sid, emoji: m.emoji, ts: Date.now() };
      if (target) payload.target = target;
      this.ctx.broadcast(S2C.reaction, payload);
    });
    this.on(C2S.chat, null, (sid, m) => s.chat.handleChat(this.ctx, sid, m));
    this.on(C2S.whisper, null, (sid, m) => s.chat.handleWhisper(this.ctx, sid, m));
    this.on(C2S.typing, null, (sid, m) => s.chat.handleTyping(this.ctx, sid, m));
    this.on(C2S.interact, 'interact', (sid, m) => this.handleInteract(sid, m));
    this.on(C2S.dropItem, null, (sid) => s.interactions.dropItem(this.ctx, sid));
    this.on(C2S.mailSend, 'mail', (sid, m) => s.interactions.mailSend(this.ctx, sid, m));
    this.on(C2S.mailRead, null, (sid, m) => s.interactions.mailRead(this.ctx, sid, m));
    this.on(C2S.updateProfile, 'appearance', (sid, m) => this.handleUpdateProfile(sid, m));
    this.on(C2S.block, null, (sid, m) => s.moderation.block(this.ctx, sid, m));
    this.on(C2S.unblock, null, (sid, m) => s.moderation.unblock(this.ctx, sid, m));
    this.on(C2S.mute, null, (sid, m) => s.moderation.mute(this.ctx, sid, m));
    this.on(C2S.unmute, null, (sid, m) => s.moderation.unmute(this.ctx, sid, m));
    this.on(C2S.report, 'report', (sid, m) => s.moderation.report(this.ctx, sid, m));
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

    if (dist(resolved, claimed) > CONFIG.movement.correctionThreshold) {
      this.sendTo(sid, S2C.correction, { x: p.x, z: p.z, y: p.y, seq, reason });
    }
  }

  private handleEmote(sid: string, emote: unknown): void {
    const p = this.state.players.get(sid);
    if (!p) return;
    if (!isEmote(emote)) return this.ctx.error(sid, 'bad_request', 'Unknown emote', C2S.emote);
    if (p.seat) return this.ctx.error(sid, 'forbidden', 'Stand up first', C2S.emote);
    p.anim = emote;
    p.animSeq = (p.animSeq + 1) % 65536;
    this.animTimers.get(sid)?.clear();
    if (emote === 'wave') {
      this.animTimers.set(
        sid,
        this.ctx.setTimeout(() => {
          const cur = this.state.players.get(sid);
          if (cur && cur.anim === 'wave') cur.anim = 'idle';
        }, CONFIG.emotes.waveDurationMs),
      );
    }
    this.ctx.broadcast(S2C.emote, { sessionId: sid, emote, ts: Date.now() });
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
    if (dist({ x: p.x, z: p.z }, target.position) > range) {
      this.sendTo(sid, S2C.interactResult, { id: target.id, ok: false, error: 'too_far' });
      return;
    }
    const result = await this.svc.interactions.interact(this.ctx, sid, target, m);
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
      getPlayer: (id) => room.state.players.get(id),
      getObject: (id) => room.state.objects.get(id),
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

