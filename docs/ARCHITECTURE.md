# Elsewhere — Architecture

Browser-based persistent multiplayer isometric social world. npm-workspaces monorepo, TypeScript strict everywhere.

```
shared/   pure TS contracts + logic (no DOM, no Node). Imported by client AND server.
server/   Node: Express + Colyseus 0.18. One port serves client build, REST, websocket.
client/   Vite + React 19 + three + @react-three/fiber 9 + drei 10 + zustand 5.
scripts/  smoke-two-clients.mjs (Playwright, global install)
docs/     this file
```

## Running

| Command | What it does |
|---|---|
| `npm install` | install all workspaces |
| `npm run dev` | server (`tsx watch`, port `PORT`/2567) + Vite (5173). Open http://localhost:5173. Vite proxies `/api`; the Colyseus client connects straight to the server port (`__SERVER_PORT__`). |
| `npm run build` | `shared` → `shared/dist`, `server` → `server/dist`, `client` → `client/dist` |
| `npm start` | `node server/dist/index.js`: serves `client/dist` + `/api/*` + websocket on `PORT` (default 2567) |
| `npm run typecheck` | builds shared d.ts, then `tsc --noEmit` per workspace |
| `npm test` | vitest (`shared/test`, `server/test`, `client/test`) |
| `node scripts/smoke-two-clients.mjs [url]` | real two-browser sync check against a running server (default `http://localhost:2567`) |

`@elsewhere/shared` exports a custom `source` condition → `src/*.ts`. Vite, vitest and `tsx` (dev) resolve it, so dev/test never need a shared build. `tsc` for the server (and `node` in production) use `dist/` — that is why `build`/`typecheck` build shared first.

Env (see `.env.example`): `PORT`, `DATA_DIR`, `SESSION_SECRET`, `DAY_LENGTH_MINUTES`, `VITE_SERVER_PORT`, `CLIENT_DIST`.

## Ownership map

| Path | Owner | Notes |
|---|---|---|
| `shared/src/**` | foundation (changes need a heads-up to all) | contracts; additive changes are fine, keep it pure |
| `shared/src/world/**` | world worker may tune values | client renders and server validates the SAME data |
| `server/src/rooms/`, `server/src/index.ts`, `server/src/services.ts`, `server/src/http/` | foundation / server worker | WorldRoom = movement + validation + routing |
| `server/src/{persistence,auth,chat,moderation,interactions,collective,memory,gazette}/` | server worker | extension seams with typed interfaces + stubs |
| `client/src/world/` | world worker | exports `<World />` |
| `client/src/characters/` | characters worker | exports `<Character />`, `<CharacterPreview />` |
| `client/src/player/` | player worker | movement controller, input (incl. touch), camera rig, interaction targeting |
| `client/src/net/` | net worker | Colyseus connection, reconnection, interpolation, typed send, REST client, debug hook |
| `client/src/ui/` | ui worker | HUD, chat, panels, onboarding, customization |
| `client/src/audio/` | audio worker | `audio.playSfx(name, position?)`, ambience, music, 3 channels |
| `client/src/state/` | shared by all (foundation) | zustand stores + transient runtime |
| `client/src/game/`, `App.tsx` | integration | scene composition; each system plugs in via its public component |

## Contracts (shared/src)

- **`math.ts`** — coordinates: X/Z ground, Y up, **+X east, +Z south**, yaw radians about +Y, `forward(yaw) = (sin yaw, cos yaw)` (three.js `rotation.y`). `rotateOffset(local, yaw)` maps object-local → world.
- **`config.ts`** — every tunable: speeds, radius, send/tick/patch rates, interpolation delay, chat radius/length, interaction radius/cooldowns, rate limits (token buckets), day length, Collective Reality thresholds, gazette cadence. Never hard-code duplicates.
- **`protocol.ts`** — `ROOM_NAME`, `C2S`/`S2C` message names with payload maps (`C2SPayloads`, `S2CPayloads`), synced-state shapes (`PlayerStateView`, `ObjectStateView`, `WorldStateView`), `JoinOptions`, REST paths (`API`) and request/response types, `ErrorCode`, enums (anims, emotes, reactions, chat channels, report reasons). All payloads JSON; server sanitizes user strings.
- **`appearance.ts`** — `Appearance` (ids only), option catalogs (`APPEARANCE_CATALOG`, `ACCESSORY_CATALOG`, warm muted palettes), `sanitizeAppearance`, `randomAppearance(seed?)`, `parseAppearanceJson`, `validateDisplayName`, `randomDisplayName`.
- **`clock.ts`** — `worldTimeAt(now, {epochMs, dayLengthMs})` → day, 0..1 `timeOfDay`, hours, `phase` (`morning | midday | golden_hour | dusk | night`), `phaseProgress`; `sunAngles`, `daylight`, `lightsShouldBeOn`. Server persists the epoch; clients add `clock.offsetMs` (from `welcome.serverTime`) via `serverNow()`.
- **`collision.ts`** — `resolveMovement(from, to, radius)` (sub-stepped, slides along colliders and shores, never ends overlapping), `isWalkable`, `collidesAt`, `findNearestWalkable`, `createCollisionWorld` (tests). Used by client prediction **and** server validation.
- **`memory.ts`** — `WorldEvent` (attributed, `significance` 0–3), `NewWorldEvent`, `GazetteIssue/Article` (articles carry `eventIds` + `templateId`), `PersistentWorldState`.
- **`world/`** — `terrainHeight(x,z)` / `groundHeight` / `isGroundWalkable` / `shoreRadius` / `islandOutline` (organic ~120×127 island, hills, Town Hall rise, promontory under The Unknown, creek through the Woods), `LOCATIONS` (9, with ambience keys), `PATHS` (winding polylines) and `DECKS` (dock + Mossy Bridge; walkable over water), `BUILDINGS` (front = local +Z, door centred on it), `INTERACTABLES` (89 entries, discriminated union by `kind`), `structures.ts` (`FOUNTAIN`, `PORTAL_ARCH` + `archPillars`, `STANDING_STONES`, `PROPS` incl. café tables), `TREES`/`ROCKS`/`BUSHES` (seeded, deterministic), `COLLIDERS` (derived from all of the above — never edit by hand), `SPAWN_POINTS`, `ITEMS`, `DISCOVERIES`.

Key data conventions:
- Seat ref in `PlayerStateView.seat`: `"<interactableId>#<seatIndex>"` (`seatRef`, `parseSeatRef`, `getSeat`). Seated character root = `seat.position` at `groundHeight + seat.height`, facing `seat.yaw`; standing up → `seat.exit`.
- `ObjectStateView` semantics per kind are documented on the interface (seat bitmask, door open, light on, bell ring count, pickup holder, fountain stage, portal awake, rune lit). Only `synced: true` interactables have entries.
- `PlayerStateView.appearance` is a JSON string (schema stays flat); parse with `parseAppearanceJson`.

## Server

`index.ts` → `initServices()` (composition root `services.ts`) → `defineServer({ rooms: { world: WorldRoom }, express })`. Express app (inside Colyseus' HTTP server) mounts `/api/*`, static `client/dist`, SPA fallback. Colyseus matchmaking (`/matchmake/*`) and websockets share the port.

`WorldRoom` (rooms/WorldRoom.ts):
- `onAuth`: protocol version check; token → profile (`auth.verify`), else ephemeral guest.
- `onJoin`: spawn ring around the fountain, `PlayerState`, `S2C.welcome`. `onDrop` → `allowReconnection(grace)`. `onLeave` → remove + persist.
- State (`rooms/schema.ts`, Colyseus schema 5 `schema()` API — no decorators): `players` map, `objects` map seeded from `SYNCED_INTERACTABLES`, `clockEpoch`, `dayLengthMs`. Compile-time checks keep it aligned with the shared `*View` interfaces. **Append new fields at the end.**
- Every C2S message goes through `on(type, rateLimitAction, handler)`: player must exist, token-bucket rate limit (`S2C.rateLimited` on reject), payload coerced to an object, errors → `S2C.error`.
- Services get a `RoomContext` (send, broadcast with filter, notice/error, timers, teleport, state access) and may implement `RoomHooks` (`onRoomCreate`, `onPlayerJoin/Leave`, `tick`, `onRoomDispose`). Register hook-bearing services in `services.ts`.

Seams (server worker fills): `persistence` (repositories; in-memory now → durable under `DATA_DIR`), `auth` (guest tokens in memory; register/login 501), `moderation` (real `RateLimiter`; block/mute/report stubs; `filterText`), `chat` (stub), `interactions` (sign/inspect/newsstand/archive work; others `not_implemented`), `collective` (loads/creates persistent world facts incl. clock epoch), `memory` (record/list), `gazette` (list/get; compile stub). Each file's header lists exactly what it must do.

## Client

- **Stores** (`state/`): `useGameStore` (connection, session/profile, roster `players` *without positions*, `objects`, `clock`, collective `world`, block/mute lists), `useUiStore` (phase, open `panel`, interaction `prompt`, notifications, `textInputFocused`, chat log), `useSettingsStore` (master + music/sfx/ambience volumes, graphics, controls; persisted to localStorage via try/catch storage).
- **Per-frame data never goes through React state**: `state/runtime.ts` holds `runtime.localPlayer` (predicted pose) and `runtime.remotes` (snapshot buffers). Read them in `useFrame`.
- **net/**: `net.connect({name, appearance})` (REST guest session → `joinOrCreate`; idempotent), `net.send(C2S.x, payload)` (typed), `net.on(S2C.x, handler)` (typed bus; every S2C type is registered), `rest.*` typed REST, `sampleRemote(id, out)` interpolation (render `interpolationDelayMs` in the past), `installDebugHook` → `window.__ELSEWHERE__.snapshot()` (read-only; used by the smoke test — keep it).
- **player/**: `LocalPlayer` (prediction with shared `resolveMovement`, sends `move` at `sendRateHz`, `stand` when moving while seated), `CameraRig` (orthographic iso, offset (30,30,30)), `input.ts` (`sampleInput`, `screenToWorld`, `setTouchMove`, `pressInteract`, `onInteractPressed`), `interaction.ts` (nearest interactable → `ui.prompt`, E → `C2S.interact`, results → panels).
- **world/**: `<World />` — renders shared world data + lighting from the clock + synced object visuals.
- **characters/**: `<Character appearance anim animSeq held highlighted castShadow />` renders at origin (feet y=0, facing +Z); parent group moves it. `<CharacterPreview appearance anim spin />` is its own Canvas.
- **ui/**: `Hud`, `Chat`, `Onboarding({onDone})`, `CustomizationScreen({initial,onSave,onCancel})`. `App` currently auto-joins as a random guest; the ui worker inserts onboarding before `net.connect`.
- **audio/**: `audio.unlock()`, `playSfx(SfxName, position?)`, `setAmbience(AmbienceKey|null)`, `playMusic(track)`, `setListener`, `gainFor(channel)`. Procedural only.

## Data flow

**Movement.** Input → `LocalPlayer` integrates speed × dt → `resolveMovement` (shared) → `runtime.localPlayer` (render immediately) → every 1/15 s `C2S.move {x,z,rot,anim,seq}` → `WorldRoom.handleMove`: drops stale seq; seated → `correction(seated)`; refills a per-player distance budget at `runSpeed × speedTolerance` (capped) and clamps the claimed move to it; `resolveMovement` from the last authoritative position; writes `PlayerState` (x, y=`groundHeight`, rot, anim, location). If the result differs from the claim by > `correctionThreshold` → `S2C.correction` → net snaps `runtime.localPlayer`. Patches (20 Hz) → client `onStateChange` pushes remote snapshots → `RemotePlayers` samples interpolated poses each frame.

**Chat.** UI → `C2S.chat {channel, text}` / `C2S.whisper {to, text}` → chat service: rate limit, `filterText`, length, `extractMentions`, block/mute filters, proximity filter via `ctx.broadcast(..., {filter})` → `S2C.chat ChatMessage` → ui chat log/bubbles; client hides muted/blocked profile ids too.

**Interaction.** Player targeting picks nearest interactable in range → prompt → `C2S.interact {id, action?}` → WorldRoom validates existence + range (+slack) + rate limit → `interactions.interact(ctx, sid, target, payload)` mutates `state.objects` / player, may `ctx.broadcast(S2C.objectEvent)`, records `memory`, signals `collective` → `S2C.interactResult {ok, error?, ui?}` to requester → panels. Object visuals update from `objects` state for everyone.

## Adding things

- New message: add name to `C2S`/`S2C` + payload type to the payload map in `shared/src/protocol.ts`; register in `WorldRoom.registerMessages` (pick a rate-limit action) or in a service; client sends via `net.send` / listens via `net.on` (automatically registered).
- New synced field: append to the schema in `server/src/rooms/schema.ts` **and** the `*View` interface; bridge it in `net/connection.ts` if UI needs it.
- New interactable: add to `INTERACTABLES` (collider derives automatically for solid kinds); run `npm test` — tests check reachability, seat exits, ids, locations.
