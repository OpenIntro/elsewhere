/**
 * Server-authoritative handling of every interactable kind
 * (shared/src/world/interactables.ts). WorldRoom has ALREADY validated that the
 * interactable exists, that the player is within its radius (+ slack), and the
 * 'interact' rate limit; this service applies the effect:
 *  - bench/chair: nearest free seat (ObjectState.value bitmask; no double
 *    seating), player.seat/anim='sit', teleport to the seat; interacting with
 *    your own bench or `stand` → seat.exit. Freed on leave/disconnect.
 *  - door: toggle active, auto-close after CONFIG.interaction.doorAutoCloseMs.
 *  - streetlight/lantern: toggle (per-object cooldown); all lights follow the
 *    clock at each dusk/dawn transition (manual toggles last until then).
 *  - bell: per-player cooldown, value++ (persisted), ObjectEvent 'bell_rung'
 *    to everyone, memory (throttled per player), collective signal (chorus, midnight).
 *  - pickup: one held item; holder + player.held; added to profile.inventory
 *    (collection). drop near the spot → back at once; elsewhere or on
 *    disconnect → respawns at its spot after pickupRespawnMs.
 *  - sign/inspect/newsstand/archive: UI payloads.
 *  - mailbox: UI + notes (mail_send / mail_read; sanitized, length-capped,
 *    rate-limited, blocked authors hidden).
 *  - hidden: per-profile discovery (profile.discoveries), S2C.discovery,
 *    'secret_found' memory; the island's first finder is announced.
 *  - fountain/rune: forwarded to CollectiveService.signal.
 *  - portal: dormant → inspect text; awake → carries the player elsewhere.
 */
import { randomUUID } from 'node:crypto';
import {
  CONFIG,
  DISCOVERIES,
  INTERACTABLES,
  S2C,
  dist,
  findNearestWalkable,
  getInteractable,
  isSeatInteractable,
  lightsShouldBeOn,
  parseSeatRef,
  seatRef,
  type Interactable,
  type InteractPayload,
  type InteractResult,
  type ItemId,
  type MailNote,
  type MailReadPayload,
  type MailSendPayload,
  type ObjectEvent,
  type SeatInteractable,
} from '@elsewhere/shared';
import { toProfileSummary } from '../auth/index.js';
import type { CollectiveService } from '../collective/index.js';
import type { MemoryService } from '../memory/index.js';
import type { ModerationService } from '../moderation/index.js';
import { sanitizeMultiline, maskProfanity } from '../moderation/text.js';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext, RoomHooks, TimerHandle } from '../rooms/RoomContext.js';

export interface InteractionDeps {
  persistence: PersistenceService;
  memory: MemoryService;
  collective: CollectiveService;
  moderation: ModerationService;
  now?: () => number;
}

export interface InteractionService extends RoomHooks {
  /** Seed state.objects for SYNCED_INTERACTABLES is done by WorldRoom; this applies the interaction. */
  interact(ctx: RoomContext, sessionId: string, target: Interactable, payload: InteractPayload): Promise<InteractResult> | InteractResult;
  stand(ctx: RoomContext, sessionId: string): void;
  dropItem(ctx: RoomContext, sessionId: string): void;
  mailSend(ctx: RoomContext, sessionId: string, payload: MailSendPayload): Promise<void>;
  mailRead(ctx: RoomContext, sessionId: string, payload: MailReadPayload): Promise<void>;
}

const FOUNTAIN_TEXT = [
  'Still water. A few coins glint at the bottom.',
  'The water hums faintly, as if remembering a tune.',
  'Light ripples up through the basin. Tiny flowers have taken root along the rim.',
  'The fountain sings. Its water rises in slow spirals and catches the sky.',
];
const PORTAL_DORMANT = 'Cold stone, older than the town. Something about it feels like it is waiting.';
/** Where an awake portal carries people: the far end of the dock, looking back at the island. */
const PORTAL_DESTINATION = { x: 14, z: 61.6 };
const BELL_MEMORY_THROTTLE_MS = 10 * 60_000;
const SAT_TOGETHER_COOLDOWN_MS = 30 * 60_000;
const PERSISTED_OBJECTS = new Set(['bell_town_hall']);

export function createInteractions(deps: InteractionDeps): InteractionService {
  const { persistence, memory, collective, moderation } = deps;
  const now = deps.now ?? Date.now;
  const ws = persistence.forWorld(collective.worldId);
  /** Transient state per ROOM instance (keyed by ctx.roomId), never shared between rooms. */
  interface RoomScope {
    doorTimers: Map<string, TimerHandle>;
    respawnTimers: Map<string, TimerHandle>;
    lightToggledAt: Map<string, number>;
    bellCooldown: Map<string, number>;
    bellMemo: Map<string, number>;
    satTogetherAt: Map<string, number>;
    lightsOn: boolean | null;
    lightAcc: number;
  }
  const scopes = new Map<string, RoomScope>();
  const S = (ctx: RoomContext): RoomScope => {
    let sc = scopes.get(ctx.roomId);
    if (!sc) {
      sc = { doorTimers: new Map(), respawnTimers: new Map(), lightToggledAt: new Map(), bellCooldown: new Map(), bellMemo: new Map(), satTogetherAt: new Map(), lightsOn: null, lightAcc: 0 };
      scopes.set(ctx.roomId, sc);
    }
    return sc;
  };
  /** Persistent per-world bell ring total (all rooms of the world add to it). */
  let bellTotal: number | null = null;

  const ev = (ctx: RoomContext, id: string, kind: ObjectEvent['kind'], sessionId: string, data?: ObjectEvent['data']) => {
    const p = ctx.getPlayer(sessionId);
    const e: ObjectEvent = { id, kind, by: sessionId, byName: p?.name ?? '', ts: now() };
    if (data) e.data = data;
    ctx.broadcast(S2C.objectEvent, e);
  };
  const touch = (ctx: RoomContext, id: string) => {
    const o = ctx.getObject(id);
    if (o) o.updatedAt = now();
    return o;
  };
  const bump = (ctx: RoomContext, sessionId: string, stat: string) => {
    const prof = ctx.getProfile(sessionId);
    if (prof) prof.stats[stat] = (prof.stats[stat] ?? 0) + 1;
  };
  const persistObject = (ctx: RoomContext, id: string) => {
    const o = ctx.getObject(id);
    if (!o || !PERSISTED_OBJECTS.has(id)) return;
    void ws.saveObject({ id, active: o.active, value: o.value, data: {}, updatedAt: o.updatedAt }).catch((e) => console.error('[interactions] persist object', e));
  };

  // --- seats -----------------------------------------------------------------

  function freeSeat(ctx: RoomContext, sessionId: string, moveToExit: boolean): void {
    const p = ctx.getPlayer(sessionId);
    if (!p || !p.seat) return;
    const ref = parseSeatRef(p.seat);
    const it = ref ? getInteractable(ref.interactableId) : undefined;
    p.seat = '';
    if (p.anim === 'sit') p.anim = 'idle';
    if (!ref || !it || !isSeatInteractable(it)) return;
    const o = touch(ctx, it.id);
    if (o) o.value = (o.value as number) & ~(1 << ref.seatIndex);
    const seat = it.seats[ref.seatIndex];
    if (moveToExit && seat) {
      const exit = findNearestWalkable(seat.exit) ?? seat.exit;
      ctx.teleport(sessionId, exit.x, exit.z);
    }
  }

  function sit(ctx: RoomContext, sessionId: string, target: SeatInteractable, action?: string): InteractResult {
    const p = ctx.getPlayer(sessionId)!;
    const o = ctx.getObject(target.id);
    if (!o) return { id: target.id, ok: false, error: 'not_found' };
    if (p.seat && parseSeatRef(p.seat)?.interactableId === target.id) {
      freeSeat(ctx, sessionId, true);
      return { id: target.id, ok: true };
    }
    const mask = o.value as number;
    const free = target.seats.map((s, i) => ({ s, i })).filter(({ i }) => (mask & (1 << i)) === 0);
    if (!free.length) return { id: target.id, ok: false, error: 'occupied' };
    let choice = free[0]!;
    const wanted = action !== undefined ? Number.parseInt(action, 10) : NaN;
    if (Number.isInteger(wanted)) {
      const exact = free.find((f) => f.i === wanted);
      if (!exact) return { id: target.id, ok: false, error: 'occupied' };
      choice = exact;
    } else {
      for (const f of free) if (dist(p, f.s.position) < dist(p, choice.s.position)) choice = f;
    }
    if (p.seat) freeSeat(ctx, sessionId, false);
    o.value = mask | (1 << choice.i);
    o.updatedAt = now();
    p.seat = seatRef(target.id, choice.i);
    p.anim = 'sit';
    p.rot = choice.s.yaw;
    ctx.teleport(sessionId, choice.s.position.x, choice.s.position.z, 'seated');
    bump(ctx, sessionId, 'seatsTaken');
    // Everyone on a full multi-seat bench, distinct people → a small moment worth remembering.
    if (target.seats.length > 1 && (o.value as number) === (1 << target.seats.length) - 1 && now() - (S(ctx).satTogetherAt.get(target.id) ?? 0) > SAT_TOGETHER_COOLDOWN_MS) {
      const sitters = ctx
        .sessionIds()
        .map((sid) => ctx.getPlayer(sid))
        .filter((pl) => pl && parseSeatRef(pl.seat)?.interactableId === target.id);
      const actors = [...new Map(sitters.map((pl) => [pl!.profileId, { profileId: pl!.profileId, name: pl!.name }])).values()];
      if (actors.length > 1) {
        S(ctx).satTogetherAt.set(target.id, now());
        void memory.record({ kind: 'sat_together', actors, locationId: target.locationId, objectId: target.id, significance: 0, data: { count: actors.length } });
      }
    }
    return { id: target.id, ok: true };
  }

  // --- pickups ---------------------------------------------------------------

  function heldPickupOf(ctx: RoomContext, sessionId: string): Interactable | undefined {
    return INTERACTABLES.find((i) => i.kind === 'pickup' && ctx.getObject(i.id)?.holder === sessionId);
  }

  function release(ctx: RoomContext, sessionId: string, putBackIfNear: boolean): void {
    const p = ctx.getPlayer(sessionId);
    const it = heldPickupOf(ctx, sessionId);
    if (p) p.held = '';
    if (!it) return;
    const o = touch(ctx, it.id)!;
    o.holder = '';
    const near = p && putBackIfNear && dist(p, it.position) <= (it.radius ?? CONFIG.interaction.radius) + CONFIG.interaction.serverSlack;
    if (near) {
      o.active = true;
    } else {
      o.active = false;
      S(ctx).respawnTimers.get(it.id)?.clear();
      S(ctx).respawnTimers.set(
        it.id,
        ctx.setTimeout(() => {
          S(ctx).respawnTimers.delete(it.id);
          const cur = ctx.getObject(it.id);
          if (cur && !cur.holder) {
            cur.active = true;
            cur.updatedAt = now();
          }
        }, CONFIG.interaction.pickupRespawnMs),
      );
    }
    ev(ctx, it.id, 'dropped', sessionId, { returned: !!near });
  }

  function pickup(ctx: RoomContext, sessionId: string, target: Extract<Interactable, { kind: 'pickup' }>): InteractResult {
    const p = ctx.getPlayer(sessionId)!;
    const o = ctx.getObject(target.id);
    if (!o) return { id: target.id, ok: false, error: 'not_found' };
    if (o.holder === sessionId) {
      release(ctx, sessionId, true);
      return { id: target.id, ok: true };
    }
    if (o.holder || !o.active) return { id: target.id, ok: false, error: 'occupied' };
    if (p.held) return { id: target.id, ok: false, error: 'forbidden' };
    o.holder = sessionId;
    o.active = false;
    o.updatedAt = now();
    p.held = target.itemId;
    const prof = ctx.getProfile(sessionId);
    if (prof) {
      prof.stats.itemsPicked = (prof.stats.itemsPicked ?? 0) + 1;
      if (!prof.inventory.includes(target.itemId as ItemId)) {
        prof.inventory.push(target.itemId as ItemId);
        void ctx.saveProfile(sessionId);
        void memory.record({ kind: 'item_picked_up', actors: [{ profileId: prof.id, name: p.name }], locationId: target.locationId, objectId: target.id, significance: 0, data: { itemId: target.itemId } });
      }
    }
    ev(ctx, target.id, 'picked_up', sessionId);
    return { id: target.id, ok: true };
  }

  // --- discoveries -----------------------------------------------------------

  async function discover(ctx: RoomContext, sessionId: string, target: Extract<Interactable, { kind: 'hidden' }>): Promise<InteractResult> {
    const def = DISCOVERIES[target.discoveryId];
    const prof = ctx.getProfile(sessionId);
    const p = ctx.getPlayer(sessionId);
    if (!def || !prof || !p) return { id: target.id, ok: false, error: 'not_found' };
    const firstTime = !prof.discoveries.includes(def.id);
    if (firstTime) {
      prof.discoveries.push(def.id);
      prof.stats.discoveries = prof.discoveries.length;
      await ctx.saveProfile(sessionId);
      const firstOnIsland = await ws.addToSet('discovery:first', def.id);
      await ws.addToSet(`discovery:${def.id}`, prof.id);
      const event = {
        kind: 'secret_found' as const,
        actors: [{ profileId: prof.id, name: p.name }],
        locationId: target.locationId,
        objectId: target.id,
        significance: (firstOnIsland ? 2 : 1) as 1 | 2,
        data: { discoveryId: def.id, firstOnIsland },
      };
      if (firstOnIsland) await memory.announce(ctx, event, `${p.name} is the first to find the ${def.name}`);
      else await memory.record(event);
      ctx.send(sessionId, S2C.discovery, { discoveryId: def.id, name: def.name, text: def.text, firstTime });
      ctx.send(sessionId, S2C.profile, toProfileSummary(prof));
    }
    return { id: target.id, ok: true, ui: { panel: 'discovery', discoveryId: def.id, name: def.name, text: def.text, firstTime } };
  }

  // --- mail ------------------------------------------------------------------

  function mailboxInRange(ctx: RoomContext, sessionId: string, mailboxId: unknown, type: 'mail_send' | 'mail_read') {
    const it = typeof mailboxId === 'string' ? getInteractable(mailboxId) : undefined;
    const p = ctx.getPlayer(sessionId);
    if (!p) return null;
    if (!it || it.kind !== 'mailbox') {
      ctx.error(sessionId, 'not_found', 'No such mailbox', type);
      return null;
    }
    if (dist(p, it.position) > (it.radius ?? CONFIG.interaction.radius) + CONFIG.interaction.serverSlack) {
      ctx.error(sessionId, 'too_far', 'Walk closer to the mailbox', type);
      return null;
    }
    return it;
  }

  async function sendMailList(ctx: RoomContext, sessionId: string, mailboxId: string): Promise<void> {
    const me = ctx.getPlayer(sessionId);
    if (!me) return;
    const notes = (await persistence.mail.list(mailboxId, 30)).filter((n) => !moderation.isBlockedBetween(me.profileId, n.fromProfileId) && !moderation.isMutedBy(me.profileId, n.fromProfileId));
    ctx.send(sessionId, S2C.mail, { mailboxId, notes: notes.slice(-20) });
  }

  // --- service ---------------------------------------------------------------

  const service: InteractionService = {
    async interact(ctx, sessionId, target, payload) {
      const p = ctx.getPlayer(sessionId);
      if (!p) return { id: target.id, ok: false, error: 'not_found' };
      switch (target.kind) {
        case 'sign':
          return { id: target.id, ok: true, ui: { panel: 'sign', title: target.title, text: target.text } };
        case 'inspect':
          return { id: target.id, ok: true, ui: { panel: 'inspect', title: target.title, text: target.text } };
        case 'newsstand':
          return { id: target.id, ok: true, ui: { panel: 'gazette' } };
        case 'archive':
          return { id: target.id, ok: true, ui: { panel: 'memory' } };

        case 'bench':
        case 'chair':
          return sit(ctx, sessionId, target, typeof payload.action === 'string' ? payload.action : undefined);

        case 'door': {
          const o = touch(ctx, target.id);
          if (!o) return { id: target.id, ok: false, error: 'not_found' };
          o.active = !o.active;
          S(ctx).doorTimers.get(target.id)?.clear();
          S(ctx).doorTimers.delete(target.id);
          ev(ctx, target.id, o.active ? 'door_opened' : 'door_closed', sessionId);
          if (o.active) {
            S(ctx).doorTimers.set(
              target.id,
              ctx.setTimeout(() => {
                S(ctx).doorTimers.delete(target.id);
                const cur = ctx.getObject(target.id);
                if (cur?.active) {
                  cur.active = false;
                  cur.updatedAt = now();
                  ctx.broadcast(S2C.objectEvent, { id: target.id, kind: 'door_closed', by: '', byName: '', ts: now() });
                }
              }, CONFIG.interaction.doorAutoCloseMs),
            );
          }
          return { id: target.id, ok: true };
        }

        case 'streetlight':
        case 'lantern': {
          const o = ctx.getObject(target.id);
          if (!o) return { id: target.id, ok: false, error: 'not_found' };
          if (now() - (S(ctx).lightToggledAt.get(target.id) ?? 0) < CONFIG.interaction.lightToggleCooldownMs) return { id: target.id, ok: false, error: 'cooldown' };
          S(ctx).lightToggledAt.set(target.id, now());
          o.active = !o.active;
          o.updatedAt = now();
          ev(ctx, target.id, o.active ? 'light_on' : 'light_off', sessionId);
          return { id: target.id, ok: true };
        }

        case 'bell': {
          const o = ctx.getObject(target.id);
          if (!o) return { id: target.id, ok: false, error: 'not_found' };
          const key = `${p.profileId}:${target.id}`;
          if (now() - (S(ctx).bellCooldown.get(key) ?? 0) < CONFIG.interaction.bellCooldownMs) return { id: target.id, ok: false, error: 'cooldown' };
          S(ctx).bellCooldown.set(key, now());
          bellTotal = Math.max(bellTotal ?? 0, o.value as number) + 1;
          o.value = bellTotal;
          o.updatedAt = now();
          persistObject(ctx, target.id);
          ev(ctx, target.id, 'bell_rung', sessionId, { rings: o.value });
          bump(ctx, sessionId, 'bellRings');
          if (now() - (S(ctx).bellMemo.get(p.profileId) ?? 0) > BELL_MEMORY_THROTTLE_MS) {
            S(ctx).bellMemo.set(p.profileId, now());
            await memory.record({ kind: 'bell_rung', actors: [{ profileId: p.profileId, name: p.name }], locationId: target.locationId, objectId: target.id, significance: 0, data: { rings: o.value } });
          }
          await collective.signal(ctx, { type: 'bell_rung', sessionId, profileId: p.profileId });
          return { id: target.id, ok: true };
        }

        case 'pickup':
          return pickup(ctx, sessionId, target);

        case 'mailbox':
          void sendMailList(ctx, sessionId, target.id);
          return { id: target.id, ok: true, ui: { panel: 'mailbox', mailboxId: target.id, canSend: moderation.chatMutedFor(p.profileId) === 0 } };

        case 'hidden':
          return discover(ctx, sessionId, target);

        case 'fountain': {
          bump(ctx, sessionId, 'fountainTouches');
          ev(ctx, target.id, 'fountain_ripple', sessionId);
          await collective.signal(ctx, { type: 'fountain_touched', sessionId, profileId: p.profileId });
          const stage = Math.round(ctx.getObject(target.id)?.value ?? 0);
          return { id: target.id, ok: true, ui: { panel: 'inspect', title: target.name, text: FOUNTAIN_TEXT[Math.min(stage, FOUNTAIN_TEXT.length - 1)]! } };
        }

        case 'rune': {
          const r = await collective.signal(ctx, { type: 'rune_touched', sessionId, profileId: p.profileId, runeIndex: target.index });
          return r.error ? { id: target.id, ok: false, error: r.error } : { id: target.id, ok: true };
        }

        case 'station':
        case 'keeper':
          // Routed to the activities service by WorldRoom; never reaches here.
          return { id: target.id, ok: false, error: 'not_implemented' };

        case 'portal': {
          const o = ctx.getObject(target.id);
          if (!o?.active) return { id: target.id, ok: true, ui: { panel: 'inspect', title: target.name, text: PORTAL_DORMANT } };
          if (p.seat) freeSeat(ctx, sessionId, false);
          const dest = findNearestWalkable(PORTAL_DESTINATION) ?? PORTAL_DESTINATION;
          ctx.teleport(sessionId, dest.x, dest.z);
          bump(ctx, sessionId, 'portalTrips');
          return { id: target.id, ok: true };
        }
      }
    },

    stand(ctx, sessionId) {
      if (moderation.rateLimiter.take(sessionId, 'stand') > 0) return;
      freeSeat(ctx, sessionId, true);
    },

    dropItem(ctx, sessionId) {
      const p = ctx.getPlayer(sessionId);
      if (!p?.held) return ctx.error(sessionId, 'bad_request', 'You are not holding anything', 'drop_item');
      release(ctx, sessionId, true);
    },

    async mailSend(ctx, sessionId, payload) {
      const it = mailboxInRange(ctx, sessionId, payload.mailboxId, 'mail_send');
      const p = ctx.getPlayer(sessionId);
      if (!it || !p) return;
      if (moderation.chatMutedFor(p.profileId) > 0) return ctx.error(sessionId, 'forbidden', 'Writing is paused for you right now', 'mail_send');
      const text = maskProfanity(sanitizeMultiline(payload.text));
      if (!text) return ctx.error(sessionId, 'bad_request', 'Write something first', 'mail_send');
      if ([...text].length > CONFIG.interaction.mailMaxLength) return ctx.error(sessionId, 'message_too_long', `Notes are limited to ${CONFIG.interaction.mailMaxLength} characters`, 'mail_send');
      const note: MailNote = { id: `note_${randomUUID()}`, mailboxId: it.id, fromProfileId: p.profileId, fromName: p.name, text, ts: now() };
      await persistence.mail.add(note);
      bump(ctx, sessionId, 'mailSent');
      await memory.record({ kind: 'mail_sent', actors: [{ profileId: p.profileId, name: p.name }], locationId: it.locationId, objectId: it.id, significance: 0 });
      await sendMailList(ctx, sessionId, it.id);
    },

    async mailRead(ctx, sessionId, payload) {
      if (moderation.rateLimiter.take(sessionId, 'mailRead') > 0) return ctx.send(sessionId, S2C.rateLimited, { action: 'mail_read', retryInMs: 1000 });
      const it = mailboxInRange(ctx, sessionId, payload.mailboxId, 'mail_read');
      if (it) await sendMailList(ctx, sessionId, it.id);
    },

    async onRoomCreate(ctx) {
      for (const s of await ws.loadObjects()) {
        if (!PERSISTED_OBJECTS.has(s.id)) continue;
        const o = ctx.getObject(s.id);
        if (o) {
          o.value = s.value;
          o.active = s.active;
          o.updatedAt = s.updatedAt;
        }
      }
      const sc = S(ctx);
      bellTotal = Math.max(bellTotal ?? 0, ctx.getObject('bell_town_hall')?.value ?? 0);
      sc.lightsOn = lightsShouldBeOn(ctx.worldTime().phase);
      for (const it of INTERACTABLES) {
        if (it.kind !== 'streetlight' && it.kind !== 'lantern') continue;
        const o = ctx.getObject(it.id);
        if (o) o.active = sc.lightsOn;
      }
    },

    tick(ctx, dtMs) {
      const sc = S(ctx);
      sc.lightAcc += dtMs;
      if (sc.lightAcc < 1000) return;
      sc.lightAcc = 0;
      const want = lightsShouldBeOn(ctx.worldTime().phase);
      if (want === sc.lightsOn) return;
      sc.lightsOn = want;
      for (const it of INTERACTABLES) {
        if (it.kind !== 'streetlight' && it.kind !== 'lantern') continue;
        const o = ctx.getObject(it.id);
        if (o && o.active !== want) {
          o.active = want;
          o.updatedAt = now();
        }
      }
    },

    onPlayerLeave(ctx, sessionId) {
      freeSeat(ctx, sessionId, false);
      release(ctx, sessionId, false);
    },

    onRoomDispose(ctx) {
      const sc = scopes.get(ctx.roomId);
      if (sc) for (const t of [...sc.doorTimers.values(), ...sc.respawnTimers.values()]) t.clear();
      scopes.delete(ctx.roomId);
    },
  };
  return service;
}
