# Elsewhere

A browser-based, persistent, multiplayer isometric 3D social world. Players create a small
character, enter a shared island (Town Square, café, Town Hall, woods, waterfront and a few
places that are not explained), walk around, chat, sit on benches, ring the bell, leave notes in
mailboxes and pick things up. The world remembers what real players did: a fountain that changes
as distinct players touch it, a dormant arch that wakes only when several players act together, a
Town Hall archive of world events, and a Gazette compiled from those events. There are no bots,
no simulated players and no invented activity; if nobody did anything, the Gazette says so.

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
| `npm test` | vitest: `shared/test`, `server/test`, `client/test` (152 tests) |
| `npm run build && npm run e2e:acceptance` | MVP acceptance: spawns its own production server (port `ACCEPT_PORT`, default 2620, fresh temp data dir, lowered fountain/Gazette thresholds), one desktop (1440x900) and one emulated phone (Pixel 7, touch) browser through the real onboarding; 17 named checks incl. restart persistence, audio and zero console errors; graphics set to "low" for headless speed; screenshots to `docs/screenshots/acceptance/` |
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

## Moderation and admin

Players can mute, block (server-enforced, persisted, manageable from Settings) and report other
players (reports include recent chat as evidence). Chat is sanitized and profanity-masked;
repeated rate-limit abuse triggers an automatic temporary chat mute.

With `ADMIN_TOKEN` set, send `Authorization: Bearer <ADMIN_TOKEN>` (or `X-Admin-Token`):

| Route | Purpose |
|---|---|
| `GET /api/admin/reports?limit=50` | player reports |
| `GET /api/admin/sanctions?active=1` / `POST /api/admin/sanctions` `{profileId, kind: 'chat_mute'\|'ban', minutes?, reason}` / `DELETE /api/admin/sanctions/:id` | sanctions (timed or permanent) |
| `POST /api/admin/kick` `{profileId? , sessionId?, reason?}` | disconnect a player now |
| `GET /api/admin/players` | who is online |
| `POST /api/admin/gazette/compile` `{periodStart?, periodEnd?}` | compile a Gazette issue now (from real events only) |

There is no admin UI; these are REST endpoints.

## Temporary assets

Everything visual and audible is generated in code and intended to be replaced by authored assets:

- Terrain, island outline, paths, water, sky (procedural geometry and shaders).
- Buildings, fences, props, benches, lamps, fountain, arch and rune stones (primitive geometry).
- Trees, bushes, rocks, flowers (seeded procedural geometry).
- Characters, hair, outfits, accessories, faces and their animations (procedural toy characters).
- All audio: music, ambience beds and every sound effect (Web Audio synthesis, `client/src/audio/`).
- UI icons (inline SVG) and illustrations. The display font is the bundled Fraunces webfont (OFL).

## Future features

Labelled "Planned" / "Not yet" in the UI (Home panel), not implemented:

- A home of your own in the Residential District, with your own mailbox.
- Decorating (furniture, plants, objects).
- Shops and trading between players (the General Store's till).
- A gentle currency earned by being around (economy).
- Weather beyond clear/haze/fog (rain and snow are typed but not rendered), NPCs.

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
