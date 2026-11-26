# Elsewhere

A browser-based, persistent, multiplayer isometric 3D social world. Players create a small
character, enter a shared island (Town Square, café, Town Hall, woods, waterfront and a few
places that are not explained), walk around and into its buildings (the Café, General Store, Town
Hall, Workshop, Boathouse and two homes have furnished interiors you walk into through the door),
chat, sit on benches and chairs, ring the bell, leave notes in mailboxes and pick things up. The world remembers what real players did: a fountain that changes
as distinct players touch it, a dormant arch that wakes only when several players act together, a
Town Hall archive of world events, and a Gazette compiled from those events. There are no bots,
no simulated players and no invented activity; if nobody did anything, the Gazette says so.

Things go on inside the buildings (see [Building activities](#building-activities)): order a
drink from the barista and sip it, play the café piano for everyone in the room, take the stage,
take a free curiosity from the store, pin a notice and vote in the town poll at the Town Hall,
build the town's next project together at the Workshop (finished projects change the island for
good), light a hearth and sign the guest book in the homes, mend nets at the boathouse. The four
public buildings have **keepers** — a barista, a shopkeeper, an archivist and a tinkerer — who are
characters of the island, never players: they wear a "keeper" tag, are never counted online, never
chat and never appear in the Gazette or World Memory.

Players can also **build** (see [Player building](#player-building)): press **B** or the Build
button, pick a piece from the palette (floors, walls, windows, doorways, roofs, steps, fences,
gates, lamps, planters, furniture, rugs and signs with your own words), and place it on a grid on
open land. Everyone sees it live, it blocks movement like any wall, it survives restarts, and only
its builder (or a moderator) can remove it. Building is free for now.

Stack: TypeScript everywhere, npm workspaces (`shared/`, `server/`, `client/`). Server: Node 22,
Express 5, Colyseus 0.18, Postgres SQL (embedded PGlite by default, `pg` for Postgres/Supabase).
Client: Vite, React 19, three.js via @react-three/fiber, zustand. Architecture details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Requires Node.js 22 or newer.

```sh
npm install
npm run build
SESSION_SECRET=$(openssl rand -hex 32) NODE_ENV=production npm start
# open http://localhost:2567
```

Without `NODE_ENV=production` you can omit `SESSION_SECRET` (an insecure development default is
used and a warning is printed).

## Local development

**Dev mode** (hot reload):

```sh
npm run dev
```

Starts the server with `tsx watch` on `PORT` (default 2567) and the Vite dev client on
http://localhost:5173. Vite proxies `/api`; the websocket client connects straight to the server
port (`VITE_SERVER_PORT`, defaulting to `PORT`, then 2567). Dev mode resolves `@elsewhere/shared`
from TypeScript sources, so no shared build is needed.

**Production mode** (one port):

```sh
npm run build                      # shared/dist, server/dist, client/dist
NODE_ENV=production SESSION_SECRET=<at least 32 random chars> npm start
```

`npm start` runs `node server/dist/index.js`, which serves the built client, `/api/*`, Colyseus
matchmaking (`/matchmake/*`) and the websocket on the single `PORT`.

Configuration is read from environment variables. A `.env` file in the repository root is loaded
at boot if present (copy `.env.example`); variables already set in the real environment win.

URL flags useful for testing: `?autojoin=1` skips onboarding and joins as a random guest. Dev
builds additionally accept world overrides (`?time=&fountain=&portal=&runes=&weather=&quality=`).

## Environment variables

All are optional in development. Source of truth: `server/src/env.ts` (server) and
`client/vite.config.ts` (dev client); `.env.example` lists the same set.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `2567` | HTTP + websocket port (client, REST, matchmaking, websocket). |
| `NODE_ENV` | (unset) | `production` enables the production safety checks and 1 h static caching. |
| `SESSION_SECRET` | insecure dev default | HMAC secret for session tokens. **Required, at least 32 chars, when `NODE_ENV=production`**; the server refuses to start otherwise. Changing it invalidates all sessions. |
| `ADMIN_TOKEN` | (unset) | Enables `/api/admin/*` (at least 16 chars; refused at boot if shorter in production). Unset: admin routes answer 404. |
| `DATABASE_URL` | (unset) | Postgres / Supabase connection string. Unset: embedded PGlite. |
| `DATA_DIR` | `server/data` | Local persistence directory; PGlite lives in `$DATA_DIR/pglite`. Relative paths resolve against the server's working directory. |
| `CLIENT_DIST` | `client/dist` | Built client directory to serve. |
| `TRUST_PROXY` | (unset) | `1`/`true`: trust `X-Forwarded-For` (per-IP rate limits behind a reverse proxy). |
| `SUPABASE_JWT_SECRET` | (unset) | Accept Supabase access tokens signed with this HS256 secret. |
| `SUPABASE_URL` | (unset) | Accept Supabase RS256/ES256 tokens via the project's JWKS; also enables the `iss` check. |
| `DAY_LENGTH_MINUTES` | `48` | Real minutes per in-world day. The clock epoch is persisted. |
| `GAZETTE_INTERVAL_MINUTES` | `360` | How often a Gazette issue is compiled (only if there were events). |
| `GAZETTE_EARLY_EVENTS` | `3` | Young world: before the first issue exists, publish once this many significant events are recorded... |
| `GAZETTE_EARLY_DELAY_SECONDS` | `60` | ...this many seconds later. |
| `FOUNTAIN_STAGES` | `5,15,40` | Contributions (one per player per world-day) needed for fountain stages 1, 2, 3. |
| `FOUNTAIN_STAGE_DISTINCT` | `3,8,20` | Minimum distinct players for each stage. |
| `PORTAL_RUNES_REQUIRED` | `2` | Distinct players who must light different rune stones within the window (min 1). |
| `PORTAL_WINDOW_MS` | `20000` | How long a lit rune stays lit. |
| `PORTAL_AWAKE_MS` | `600000` | How long the portal stays awake. |
| `BELL_CHORUS_PLAYERS` | `3` | Distinct players ringing the bell within 8 s for its other voice (min 2). |
| `GATHERING_THRESHOLD` | `6` | Players in one place that count as a gathering (min 2). |
| `DRINK_MINUTES` | `4` | Café: how long a drink lasts in hand (it also runs out after 6 sips). |
| `STORE_TAKES_PER_DAY` | `1` | General Store: free curiosities one player may take per world-day. |
| `NOTICE_MAX_PER_PLAYER` | `2` | Town Hall: notices one player may have up at once. |
| `NOTICE_EXPIRY_HOURS` | `72` | Town Hall: how long a notice stays up (real hours). |
| `POLL_PERIOD_DAYS` | `1` | World-days per town-poll question (the result is recorded when the period ends, if anyone voted). |
| `WORKSHOP_STAGE_CONTRIBUTIONS` | `6,10,14` | Workshop town project: pieces of work needed for each stage (one entry per stage; the last stage finishes the project). |
| `WORKSHOP_STAGE_DISTINCT` | `2,3,4` | Minimum DIFFERENT players for each stage. |
| `WORKSHOP_DAILY_CONTRIBUTIONS` | `3` | Pieces of work one player may do per world-day. |
| `HEARTH_MINUTES` | `20` | Homes: how long a lit hearth burns (real minutes). |
| `NET_SECTIONS` | `5` | Boathouse: sections per net (one mend per player per world-day). |
| `BUILD_ENABLED` | on | `0`/`false` switches player building off (placements are refused with "Building is switched off"; existing pieces stay). |
| `BUILD_RANGE` | `9` | Max distance (m) from the builder to a piece's centre. |
| `BUILD_MAX_PER_PLAYER` | `400` | Pieces one profile may own at once. |
| `BUILD_MAX_PER_WORLD` | `6000` | Pieces in one world. |
| `BUILD_RATE_CAPACITY` / `BUILD_RATE_PER_SECOND` | `8` / `2` | Per-profile token bucket for place + remove (survives reconnects). |
| `ELSEWHERE_DEBUG` | (unset) | `1`: extra server diagnostics (e.g. logs refused out-of-range interactions). |
| `VITE_SERVER_PORT` | `PORT`, then `2567` | Dev client only: server port the Vite client connects to. Read from the shell, not from `.env`. |

Defaults for everything not configurable by env (speeds, rates, radii, rate limits, cooldowns)
live in `shared/src/config.ts`.

## Database

Migrations run automatically at boot (`server/src/persistence/migrations.ts`, tracked in
`schema_migrations`).

- **PGlite (default).** Nothing to install. Data lives in `$DATA_DIR/pglite`; back up that
  directory (with the server stopped) to back up the world. One server process per data dir.
- **Plain Postgres.** Create a database and set
  `DATABASE_URL=postgres://user:pass@host:5432/elsewhere`. The server uses a pool of 8 connections.
- **Supabase.** Use the project's connection string (the pooler URL) as `DATABASE_URL`. TLS is
  enabled automatically for URLs containing `sslmode=require`, `supabase.co` or `supabase.com`,
  **without certificate verification** (`rejectUnauthorized: false`), see limitations below.

## Authentication

- **Guest (default).** Onboarding creates a guest profile; an opaque HMAC-signed token
  (`es1.…`, only its sha256 is stored) is kept in the browser's localStorage and resumes the same
  profile after reloads and server restarts.
- **Account.** Players can register (username + password, scrypt-hashed) during onboarding or
  upgrade their guest profile later from Settings (same profile kept). Login has per-username
  lockout and per-IP rate limits. Logout revokes the token.
- **Supabase Auth (optional).** With `SUPABASE_JWT_SECRET` and/or `SUPABASE_URL`, a Supabase
  access token is accepted wherever a session token is; its `sub` maps to a registered profile.

## Multiplayer server configuration

| Setting | Where | Value |
|---|---|---|
| Room capacity | `CONFIG.network.maxClientsPerRoom` | 50 players per room instance |
| Instances | Colyseus `joinOrCreate` | A new instance of the `world` room is created when the current one is full. All instances share persistent world state (fountain, portal awakenings count, memory, Gazette, mail, profiles); transient state (lit runes, bell chorus, chat history, seats) is per instance. |
| Tick / patch rate | `CONFIG.network.tickRateHz`, `patchRateHz` | 20 Hz / 20 Hz |
| Client move send rate | `CONFIG.movement.sendRateHz` | 15 Hz; server clamps to run speed x 1.35 |
| Reconnect grace | `CONFIG.network.reconnectGraceSeconds` | 20 s |
| Day length | `DAY_LENGTH_MINUTES` | 48 min |
| Collective thresholds | `FOUNTAIN_*`, `PORTAL_*`, `BELL_CHORUS_PLAYERS`, `GATHERING_THRESHOLD` | see table above; `GET /api/world` lists the active rules |
| Gazette timing | `GAZETTE_INTERVAL_MINUTES`, `GAZETTE_EARLY_*` | 6 h cadence; first issue 60 s after 3 significant events |

Horizontal scaling across several Node processes is not implemented (Colyseus presence/driver is
the default in-process one).

## Deployment

The server is a single process on a single port.

- **Container.** `docker build -t elsewhere .` then
  `docker run -p 2567:2567 -e SESSION_SECRET=... -v elsewhere-data:/data elsewhere`.
  The image is multi-stage, runs as the non-root `node` user, sets `NODE_ENV=production`,
  `DATA_DIR=/data` (a volume) and has a health check on `/api/health`.
- **Persistence.** Either mount a persistent volume at `DATA_DIR` (PGlite) or set `DATABASE_URL`.
  Without either, the world is lost when the container is replaced.
- **Reverse proxy.** Forward all paths (including `/matchmake/*` and websocket upgrades) to the
  one port; enable websocket upgrade (`Upgrade`/`Connection` headers) and generous read timeouts.
  Set `TRUST_PROXY=1` so per-IP rate limits use `X-Forwarded-For`. Terminate TLS at the proxy;
  the production client connects to the page's own origin, so no client configuration is needed.
- **Secrets.** Set `SESSION_SECRET` (32+ random chars) and, if you want admin tools,
  `ADMIN_TOKEN` (16+ chars). Never put them in the client build; nothing in `client/` reads them.
- Built client assets are served with 1 h caching; production source maps are published next to
  the bundles (`client/vite.config.ts` `sourcemap: true`).

## Testing

| Command | What it runs |
|---|---|
| `npm run typecheck` | builds shared type declarations, then `tsc --noEmit` per workspace |
| `npm test` | vitest: `shared/test`, `server/test`, `client/test` |
| `npm run build && npm run e2e:acceptance` | MVP acceptance: spawns its own production server (port `ACCEPT_PORT`, default 2620, fresh temp data dir, lowered fountain/Gazette thresholds), one desktop (1440x900) and one emulated phone (Pixel 7, touch) browser through the real onboarding; 17 named checks incl. restart persistence, audio and zero console errors; graphics set to "low" for headless speed; screenshots to `docs/screenshots/acceptance/` |
| `npm run build && npm run e2e:activities` | building activities: own production server (port `ACT_PORT`, default 2633, fresh temp data dir, **lowered** `WORKSHOP_STAGE_CONTRIBUTIONS=2,2 WORKSHOP_STAGE_DISTINCT=2,2`), a desktop and a phone browser through the real UI; 12 named checks — same keeper state on both, hearth, guest book, notice board, town poll (real tally 2), barista drink seen in hand by the other, piano notes received + played by the other's audio graph, the town project finished by both (stage advance + lanterns outside), online count stays 2 with keepers on duty, everything still there after a server restart, zero console errors. Screenshots with `ACT_SHOTS=<dir>` |
| `npm run build && npm run e2e:interiors` | walk-in interiors: own production server (port `INT_PORT`, default 2631), a desktop and a phone browser; 9 named checks — click-to-move into the Café through its door, keyboard walking in and out, cutaway open inside / closed outside, name tags + speech bubble + interaction prompt indoors, an indoor chair seen seated by the other client, walls hold, zero console errors |
| `npm run build && npm run e2e:build` | player building: own production server (port `BUILD_PORT`, default 2634, fresh temp data dir), a desktop and a phone (Pixel 7, touch) browser through the real build UI; 11 named checks — palette, a hut built by A (floor, walls, doorway, window, roof, lamp, sign with text) seen identically by B, a protected spot and a spot on another player refused with a visible reason, B cannot remove A's piece and forged remove/place messages are refused by the server, B blocked by A's wall but walking in through A's doorway (server positions), B builds by touch, A removes a piece and B sees it go, everything still there after a server restart, a late joiner receives every piece, zero console errors. Screenshots with `BUILD_SHOTS=<dir>` |
| `node scripts/build-screenshots.mjs [devUrl]` | builds a cottage through the real UI (dev client) and shoots palette / valid + refused ghost / the cottage by day and night on desktop and phones → `docs/screenshots/build/` (`SHOTS_ADMIN_TOKEN` clears leftovers of an earlier run) |
| `npm run build && npx tsx --conditions=source scripts/build-scale.mts [--pieces 2000]` | seeds N pieces through the real server path and measures join, bytes, render cost and server timing (numbers under "Player building") |
| `node scripts/interior-screenshots.mjs [devUrl]` | every interior day/night on desktop and phone + exteriors at night + the four camera rotations → `docs/screenshots/interiors/` (dev client; uses `?inside=`) |
| `node scripts/smoke-two-clients.mjs [url]` | two browsers join and see each other move |
| `npx tsx --conditions=source scripts/server-integration.mjs [url] --save f.json` then restart the server and `... --verify-restart f.json` | multi-client protocol test (chat, seats, bell, fountain, portal, Gazette, persistence); see the script header for the server env it expects |
| `node scripts/e2e-player.mjs` | movement, camera, click/tap-to-move, collision, remote smoothness, server restart reconnection, touch controls (spawns its own server) |
| `E2E_ADMIN_TOKEN=... node scripts/e2e-ui.mjs [url]` | full UI flow incl. panels, settings persistence, mute/block, mailbox, items, register/login, Gazette (~12-15 min) |
| `npx tsx --conditions=source scripts/load-clients.mts --clients 40 --server <url>` | headless protocol clients random-walking (load test tool) |

Browser scripts need Playwright with Chromium available to `require('playwright')`.

## Controls

| Input | Action |
|---|---|
| WASD / arrow keys | walk (camera-relative); hold Shift to run (inverted by the "run by default" setting) |
| Click / tap the ground | walk there (pathfinding) |
| Click / tap an object or player | walk to it and use it / open the player card |
| E | interact with the highlighted object |
| Space | contextual: interact, stand up, or wave |
| Enter | open chat |
| Esc | close panel, cancel path, recenter camera |
| Q / R | rotate camera 90 degrees |
| + / -, mouse wheel, pinch | zoom |
| C | recenter camera |
| Drag on the world | pan the camera |
| Touch | virtual joystick, round interact button, on-screen rotate/zoom buttons |
| Drag the character preview | rotate it (customization screen) |
| Click / tap a keeper, or E near their counter | talk to the keeper: a short line about the island today + the building's menu (order a drink, today's curiosities, the poll, the town project) |
| Piano panel | click / tap the keys; on a keyboard the Z…M row plays the low octave and Q…I the high one (movement keys are paused while the piano is open) |
| Sip chip (bottom of the screen) | sip the drink in your hand |
| B / Build button | enter / leave build mode (the build dock replaces the bottom nav) |
| Build mode: mouse | hover aims the ghost (green = fits, red + reason = refused), click places; pointing at the top of your wall puts the next storey or a roof there |
| Build mode: keys | R (Shift+R) turn the piece, Enter place, X / Delete remove tool, Ctrl/Cmd+Z undo your last piece, Esc or B done; WASD still walks |
| Build mode: touch | tap the ground to aim, then the Place button; Rotate / Remove / Undo / Done buttons; the joystick still walks |
| Remove tool | click / tap one of your pieces → Remove (pieces holding others up go last); someone else's piece → Report |
| Settings → Stuck somewhere? (also in the build dock's ··· menu) | Unstuck: back to the Town Square (once every 30 s) |
| Walk through a door | enter a building: its roof and the walls between you and the camera fade away (dollhouse cutaway, any camera rotation); walk out and they come back. Clicking a spot inside a building from outside walks you in through the door |

## Building activities

Rules are data in `shared/src/activities.ts`; the server (`server/src/activities/`) validates every
action (range, same side of the wall, rate limits, per-day limits, moderation) and syncs the result
to everyone (`state.activities`, `state.keepers`). Everything you see is either a real player's
action or clearly the world itself (keepers, a kettle coming to the boil, a hearth burning down).

| Building | Activity | Synced live | Persisted |
|---|---|---|---|
| Café | Keeper **Mara** (barista), 06:30–22:00 | position, task, gesture, on duty | — (simulated from the clock) |
| Café | Order a drink (coffee, tea, cocoa, today's special); sip it; it runs out | the cup in your hand (held item) | no (a drink is transient) |
| Café | Piano (on-screen keys / keyboard) | every note to everyone in or near the café (spatial) | — (a World Memory line, throttled) |
| Café | Stage | soft spotlight on whoever stands on it; their chat carries through the café | — |
| Café | Today's special on the chalkboard | changes with the world day | derived from the day |
| General Store | Keeper **Odile** (shopkeeper), 08:00–19:00 | as above | — |
| General Store | Three free curiosities a day ("on the house, for now"), one per player per world-day, into your things | the table | your collection + the daily limit |
| General Store | Try-on mirror (opens the appearance screen) | your appearance | your profile |
| Town Hall | Keeper **Ferris** (archivist), 08:00–20:00 | as above | — |
| Town Hall | Notice board: pin (≤160 chars, filtered), 2 up per player, expire after 72 h, owner/admin removal, reportable | the board | yes (`activity_notes`) |
| Town Hall | Town poll: one question per world-day, one vote per profile, real tallies ("no votes yet") | tallies | yes (`poll_votes`); the result goes to World Memory + Gazette when the period ends (only if anyone voted) |
| Town Hall | Lectern | spotlight; chat carries through the hall | — |
| Workshop | Keeper **Bram** (tinkerer), 07:00–19:00 | as above | — |
| Workshop | Town project (lumber rack / anvil / kiln): each stage needs N pieces of work by M different players; 3 a day per player | the project on the sawhorses, stage by stage | yes; finished projects change the island for good: lanterns across the Town Square → a weather vane on the General Store → bunting along the dock |
| House 1 & 2 | Light the hearth (burns 20 min; fire, window glow at night, chimney smoke) | lit / burning down | yes |
| House 1 & 2 | Put the kettle on (boils, whistles, steams) | kettle state | no |
| House 1 & 2 | Guest book (≤120 chars, filtered, once per player per day per book, owner removal, reportable) | the book | yes |
| Boathouse | Mend the nets (one section per player per day; a full net is recorded) | mended sections | yes |
| Boathouse | Tide log (like a guest book) | the log | yes |
| Everywhere | Presence: real players inside each building, on the door prompt and the map (0 shown as "nobody inside") | counts | — |

Ambient world behaviour: espresso steam while the barista works, steam over cups in hand,
flickering hearths, wall clocks showing the world time, OPEN / CLOSED signs and keepers on duty by
the shared clock (closed buildings stay enterable, just quiet). Sounds (piano, cups, saw / anvil /
kiln, hearth, kettle, pins, pages, ballots, nets) go through the procedural audio system: positional,
muffled through walls, on the effects volume.

Admin: `GET /api/admin/notes?board=&limit=` and `DELETE /api/admin/notes/:id` (notices, guest-book
and tide-log entries). Reports of entries land in the normal reports list with the entry as evidence.

## Player building

The catalog, the grid and every rule are data in `shared/src/building.ts` (client preview and server
validation run the same code); the server (`server/src/building/`) is authoritative; the client lives
in `client/src/build/`.

- **Pieces** (3-4 muted styles each): floor tile (2x2 m), wall, wall with window (glows at night),
  doorway (walk-through), half wall, pillar; flat roof, roof slope (two make a pitched gable roof),
  peaked roof, gable end; steps; fence, gate (walk-through); table, bench, chair, lamp (lights
  itself at dusk by the world clock), planter, crate, rug, and a sign carrying up to 40 characters
  of your text (sanitized and profanity-masked like chat; refused while chat-muted).
- **Grid and storeys:** centres on a 0.5 m grid (structure snaps to 1 m), quarter-turn rotation,
  storeys 2.6 m. Walls stack on walls (two storeys of walls plus a roof and more: level 0..3);
  upper floors and roofs rest on walls/pillars of the storey below, furniture upstairs on an upper
  floor. Upper pieces may only rest on **your own** pieces.
- **Where:** open land of the island only. Refused: off-island and water, building footprints and
  door aprons (`PROTECTED_ZONES` from the interiors data, plus 1 m), paths (+0.7 m), the Town
  Square, The Unknown, 2.2 m around every interactable (benches, signs, mailboxes…), 3 m around
  spawn points, landmarks (fountain, arch, standing stones), the dock and bridge, steep ground,
  trees/rocks/props, other pieces of the same layer, a solid piece over any player (in any room
  instance), and anything further than `BUILD_RANGE` from you.
- **Anti-grief:** per-profile rate limit, per-player and per-world caps, no building within 4 m of
  pieces of someone you blocked or who blocked you, banned and build-banned players cannot build,
  only the owner removes a piece, and Unstuck is always available.
- **Collision:** solid ground-level pieces block movement for everyone (shared collision used by
  server validation and client prediction) and the click-to-move pathfinder; floors, rugs and steps
  never block, doorways and gates are open in the middle. Characters stand on floor boards and steps.
- **World Memory / Gazette:** a resident's first piece, island milestones of pieces placed (10, 100,
  500, …) and the first roof that closes walls with a doorway — only real events.
- **Rendering:** one instanced mesh per piece kind + style + material (40-50 draw calls for 2,000
  pieces), shadows like the world; roofs and upper storeys over or next to you dissolve (dithered,
  their shadow too), and tall walls between the camera and you thin out.

Measured with `scripts/build-scale.mts` (production build, one machine, headless Chromium with
**software** WebGL — frame times say nothing about real GPUs): 2,000 pieces seeded through the real
server path in 5.5 s (validation 0.14 ms average, 2 ms max per placement); a joining browser got
them as a 4-chunk snapshot of 74 KB on the websocket (90 KB as JSON; 9 KB for an empty world)
applied in 9 ms; idle websocket traffic stayed ~100-150 B/s with or without pieces (pieces are not
in the Colyseus state); the build layer drew 47 calls / 0.58 M triangles (whole frame 133 calls /
1.0 M triangles vs 83 / 0.42 M empty; frame time 407 ms vs 288 ms in software rendering); with 30
protocol clients walking, the server's event-loop delay p99 was 12.9 ms with 2,000 pieces vs 14.4 ms
with none (timer resolution ~10 ms); `resolveMovement` next to pieces ~70 µs per 1.6 m move; a
restart loaded all 2,000 pieces and was healthy in 0.65 s.

## Moderation and admin

Players can mute, block (server-enforced, persisted, manageable from Settings) and report other
players (reports include recent chat as evidence). Chat is sanitized and profanity-masked;
repeated rate-limit abuse triggers an automatic temporary chat mute.

With `ADMIN_TOKEN` set, send `Authorization: Bearer <ADMIN_TOKEN>` (or `X-Admin-Token`):

| Route | Purpose |
|---|---|
| `GET /api/admin/reports?limit=50` | player reports |
| `GET /api/admin/sanctions?active=1` / `POST /api/admin/sanctions` `{profileId, kind: 'chat_mute'\|'ban'\|'build_ban', minutes?, reason}` / `DELETE /api/admin/sanctions/:id` | sanctions (timed or permanent; `build_ban` = may play and chat, may not build) |
| `POST /api/admin/kick` `{profileId? , sessionId?, reason?}` | disconnect a player now |
| `GET /api/admin/players` | who is online |
| `POST /api/admin/gazette/compile` `{periodStart?, periodEnd?}` | compile a Gazette issue now (from real events only) |
| `GET /api/admin/notes?board=&limit=` / `DELETE /api/admin/notes/:id` | notices, guest-book and tide-log entries (moderation) |
| `GET /api/admin/build/pieces?owner=&limit=` | placed pieces, newest first (owner, kind, position, sign text) |
| `DELETE /api/admin/build/pieces/:id` | remove a piece and everything resting on it (owners get a notice) |
| `DELETE /api/admin/build/profiles/:profileId` | remove every piece a profile owns |
| `GET /api/admin/build/stats?bench=1&reset=1` | piece counts, validation timing, event-loop delay, snapshot size |

Players report a built piece (e.g. a rude sign) with the remove tool → Report on someone else's
piece; it goes through the normal report flow against the builder's profile, with the piece and its
text as details.

There is no admin UI; these are REST endpoints.

## Temporary assets

Everything visual and audible is generated in code and intended to be replaced by authored assets:

- Terrain, island outline, paths, water, sky (procedural geometry and shaders).
- Buildings, fences, props, benches, lamps, fountain, arch and rune stones (primitive geometry).
- Building interiors: walls, floors, furniture (counters, shelves, tables, chairs, piano, lectern,
  workbenches, kiln, beds, hearths, boats…), wall pictures and pendant lamps (primitive geometry,
  `client/src/world/arch/walkin.ts` + `furniture.ts`). Houses 3-5 are closed "future homes".
- Trees, bushes, rocks, flowers (seeded procedural geometry).
- Characters, hair, outfits, accessories, faces and their animations (procedural toy characters).
- All audio: music, ambience beds and every sound effect (Web Audio synthesis, `client/src/audio/`).
- UI icons (inline SVG) and illustrations. The display font is the bundled Fraunces webfont (OFL).

## Future features

Labelled "Planned" / "Not yet" in the UI (Home panel), not implemented:

- A home of your own in the Residential District, with your own mailbox (two homes can be walked
  into already; houses 3-5 are marked "a future home").
- Decorating the walk-in homes' interiors (player building is outdoors, on open land).
- Buying building pieces (economy): building is free for now.
- Shops and trading between players (the General Store's till).
- A gentle currency earned by being around (economy). Until then the store's curiosities and the
  café's drinks are free ("on the house, for now").
- Weather beyond clear/haze/fog (rain and snow are typed but not rendered). Keepers are the only
  world characters; they do not wander the island or hold conversations.

## Not verified / known limitations

These were not checked, or were checked only in a limited way:

- **Real Postgres and Supabase were never run.** Only the embedded PGlite path was exercised (all
  tests and e2e runs). The `pg` driver path, the Supabase pooler and **Supabase JWT verification**
  (HS256 and JWKS) have unit coverage at most and were never run against a real database or a
  real Supabase project.
- Supabase/`sslmode=require` connections are made with TLS certificate verification disabled.
- **Frame rate** was only measured under headless Chromium with software WebGL rendering, never on
  real desktop or mobile GPUs. Mobile was tested by Chromium device emulation (Pixel 7), not on
  physical phones or Safari/WebKit.
- **Audio was verified by inspecting the Web Audio graph** (context state, bus gains, sfx
  counters), never by listening.
- **The online count is per room instance**: with more than 50 players there are several
  instances and each shows its own count.
- **Rain and snow weather are placeholders** (typed, not rendered).
- **Gazette, mail, profiles and moderation are not partitioned per world instance**: all room
  instances share one Gazette, one set of mailboxes and one profile/sanction store.
- **Load:** `scripts/load-clients.mts` was run once on the development machine (4 cores) against a
  production build: 40 and 50 headless protocol clients (no rendering) random-walking at 15 Hz for
  25-30 s joined in about 0.6 s, with 0 movement corrections; the server used about 7% of one
  core and about 465 MB RSS (mostly PGlite) with 50 clients. Clients and server shared one machine
  and one network; there was no test with 20-50 real browsers on real hardware or over a real
  network.
- The Docker image was built and run once in the development sandbox, but only with build-time
  proxy/CA settings injected into a scratch copy of the Dockerfile (the sandbox's network needs
  them) and with the base image pulled from `public.ecr.aws/docker/library/node:22-bookworm-slim`
  (`--build-arg NODE_IMAGE=...`) because Docker Hub rate-limited the pull. In that run: the
  container refused to start without `SESSION_SECRET`, ran as uid 1000 (`node`), served the client
  and passed `scripts/smoke-two-clients.mjs`, and a guest token resumed the same profile after
  `docker restart` with a named volume on `/data`. The unmodified Dockerfile was not built end to
  end. The image is about 640 MB (client runtime packages stay in `node_modules`).
- Horizontal scaling across processes/machines is not implemented.
- On a narrow phone screen a world-event toast can briefly overlap the top of the camera buttons
  on the right edge (seen in the acceptance screenshots; toasts are transient and dismissible).
- Server-side movement validation clamps speed to run speed x 1.35 plus a small budget; a
  modified client can still move at that rate, and paths are validated against shared colliders,
  not against a server-side navmesh.
- Production builds publish source maps.
- **Interiors:** the browser e2e (`e2e:interiors`) walks into and out of the Café only; the other
  interiors are covered by unit tests (reachability of every anchor and seat through its door,
  walls blocking, click-to-move paths) and screenshots, not by browser walks. Doors are open
  passages: the door leaf swings open when someone is near, and a "closed" door does not block.
  Outdoor trees are not faded by the cutaway and can hide part of a room at some rotations.
- **Player building:** built benches and chairs are furniture only — sitting on them is not
  implemented (seats are tied to the fixed interactables data). Only ground-level pieces collide:
  upper storeys are visual (players never walk upstairs; steps are a low step, not a staircase).
  Pieces have no hit points, decay or claim areas; the per-player cap, rate limit and admin removal
  are the only limits on how much one person builds. Removing a piece that holds others up is
  refused (remove the top first); admins remove the whole stack. Roofs are 2 m tiles, so long roofs
  show a seam between tiles and have no overhang at the gable ends. The browser e2e and the 2,000
  piece measurement ran on one machine with headless software-rendered Chromium; real GPUs, real
  phones and Safari were not tried. Sign text is masked by the same word list as chat (not an
  image/meaning filter) and is reportable.
