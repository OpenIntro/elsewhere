# Cycle 02 — Ideas committee proposals

Date: 2026-11-27. Read-only pass: no builds, tests, servers or browsers were run (combined QA is
running on this machine). Grounded in `docs/ideas/` (README, backlog, cycle 01 proposals and
decisions), README.md (features, future features, limitations), and the code areas named below.

## What changed since cycle 01

- Built: **Brief A** built interiors that cut away (`shared/src/buildEnclosure.ts`, `aCut` in
  `client/src/build/BuildLayer.tsx`), **Brief B** the landscape build strip and peek sheets
  (`docs/screenshots/phone/`), **Brief C** the runner and door audit (`npm run e2e:all`,
  `npm run e2e:doors`, `scripts/lib/server.mjs`, `report.mjs`). Also two fixes the owner asked for:
  the roof tool attaches reliably (`e2e:roofs`, `shared/test/roofs.test.ts`), and camera rotation is
  easier to find (`e2e:camera`).
- Door audit (`e2e-results/doors.json`): `ok: true`, `stallReproduced: false` over the emulated
  phone walks. It did find a **detour round House 1**: the tap-to-move grid treats the gap between
  House 1 and House 2 as closed (backlog row, repro
  `npm run e2e:doors -- --doors house_2 --spawns 2`).
- Lessons from the cycle 01 vetting that shape this file: say "new code" when it is new code (owner
  removal of guest-book entries, send-side mail blocks and private inboxes did not exist), keep
  per-home data out of the Colyseus `state.activities` map, no distance LOD under the orthographic
  camera, and design env overrides into any rule that would break an existing e2e.

## Part 1 — Decisions the owner delegated to the committee

These are decisions, not questions. Each has the rationale the five seats agreed on, and dissent
where there was any.

### D1. Houses 3-5: **public houses, opened one at a time, never claimable**

- Houses 3-5 become shared places, each with one thing to do, opened one per cycle. House 3 opens
  first, as **the Post House** (proposal 5). Houses 4 and 5 keep "a future home" until their turn.
  Candidates for later: a reading room, and a seed house for garden plots (backlog).
- Rationale: three houses for every player who will ever join cannot be shared out fairly (first
  come rewards whoever logs in first; rotating makes a home that is not yours). A home of your own
  now comes from building one (proposal 1), which has no scarcity. "Public with an activity" fits
  the owner's "things should be going on in each of the buildings".
- The label changes from "a future home" to the house's name only when it opens. Nothing the owner
  asked for is removed.
- Dissent: Regular would have liked one claimable "starter cottage" for people who don't build;
  outvoted because it brings back the fairness problem.

### D2. What the home mailbox means: **a private letterbox for addressed letters**

- Letters are addressed to a resident and only that resident can read them. They are posted at the
  Post House desk (or from the player card of someone you can see). They are collected at the Post
  House pigeonholes, or at your own home's mailbox if you have made a home.
- Today's public mailboxes stay exactly as they are: public note boxes keyed by `mailboxId`, which
  anyone at the box can read (`server/src/interactions/index.ts` `sendMailList`).
- Blocks are enforced **when sending** (new; `mailSend` checks no relations today) as well as when
  reading. There are limits per sender per day and per recipient per day. Letters are reportable,
  and the recipient can delete any letter.
- Rationale: "a mailbox that's yours" is what the Home panel promises (`SimplePanels.tsx` `FUTURE`).
  Delivery to the Post House means players without a home get letters too, so homes don't create
  a two-class mail system.

### D3. Map pins for homes: **opt-in, off by default**

- A home shows on the island map only if its owner turns "Show my home on the map" on (Home panel).
  The pin reads "Fern Cottage · Ivy". Pins of banned or build-banned players are never shown. A pin
  never shows whether the owner is online.
- Rationale: a map pin is an invitation to visit. Some players will want it, but it should never
  be the default. The house itself is visible in the world either way.

### D4. Currency: **none for now** (revisit only when trading between players exists)

- There is still no currency, earned or otherwise. Progression stays shared and visible: Workshop
  projects that unlock things for everyone (proposal 8), homes, named houses, the Gazette.
  "On the house, for now" stays. The Home panel's "A gentle currency — earned by being around, never
  bought" card stays as a planned idea; it is not removed.
- Rationale: with free guest profiles, any currency earned by being around rewards idling and alt
  farming, and needs sinks and balancing. There is nothing to buy today that isn't free. When a
  currency would actually let players do something new (a till at the General Store, swapping
  between players), it comes back as a proposal with earned-only rules. Real money never.
- Dissent: New player seat liked a small "thank-you token" for helping with projects; parked.

### D5. Co-building: **yes, by invitation, on your home only, with an anti-pinning rule** (proposal 7)

- A home owner may invite up to 4 named **helpers** to their home. Helpers may place pieces inside
  the home's area (the house's enclosure plus 1 m) and on top of the owner's pieces there.
- Anti-pinning rule: **in your own home, nothing anyone else placed can ever stop you removing your
  own piece.** The owner can remove any helper's piece in the home, and removing an owner piece that
  a helper's piece rests on removes the helper's piece with it (the helper gets a notice). A helper
  can never remove an owner's piece. Outside invited homes, the old rule stays: upper pieces rest
  only on your own pieces.
- Uninviting someone does not delete their pieces. Blocking a helper (either way) uninvites them.
  Helper pieces count against the helper's own piece cap.
- Rationale: "things to do with others" was the regular's top ask. Keeping it to your home makes
  the permission easy to understand and keeps the anti-pinning guarantee simple to test.

### D6. Doors that close or lock: **built doors may close and latch; nobody can ever be trapped** (proposal 9)

- A new door leaf can hang in a built doorway. A closed door blocks walking through it like a wall,
  and E (or walking into it from inside) opens it. On a home, the owner can **latch** it: then only
  the owner and helpers can open it **from outside**. From inside, anyone can always open it, so
  nobody can be shut in.
- Unstuck always works. Town buildings' doors never block (unchanged, still enforced by tests).
  A door cannot be latched while it is the only way out of a space with someone in it. The server
  answers this with "anyone inside can always open it", so no exception is needed.
- Rationale: privacy for a home is what makes it feel like a home, and the no-trap rule is cheap to
  guarantee if exit is unconditional.
- Dissent: Mod accepted only with the unconditional exit plus a browser check that a latched-out
  visitor inside a home can always leave.

## Part 2 — Open backlog rows considered

| Backlog row | This cycle | Why |
|---|---|---|
| Stairs and walkable upper floors | **not proposed** (cycle 03) | Brief A landed, but the frame meter has not (cycle 01 vetting made it a prerequisite), and homes take this cycle's server and migration attention. Mitigations stay hard requirements: `BUILD_UPSTAIRS` flag, level-0 equivalence property test, Unstuck. |
| Workshop makes new pieces | **reshaped → proposal 8** | Unlocks **colour styles only** (variants of existing pieces), so no new mesh art; more outdoor projects first so the Workshop stops dead-ending; anti-farming rule behind an env override. |
| L/T/U roofs | **stage 1 → proposal 4** (hip tile courses, S) | Stage 2 (joined L roofs) waits; the roof tool was just reworked, so give it a cycle to settle. |
| Frame budget rewrite | **proposal 2** | Reshaped as the vetting asked: production-safe meter, baseline script, spatially chunked build instancing. No distance LOD; adaptive quality not yet. |
| Legacy roof tile migration | **not proposed** | A data migration that rewrites players' pieces is high risk for a cosmetic gain (seams on old tiles). It waits for joined roofs, since many legacy builds are L-shaped. |
| Nav-grid detour round House 1 | **proposal 3** (S) | Found and reproducible; small; improves every tap-to-move near the homes, which is where homes will bring people. |
| Phone tap-to-move stall | folded into proposal 3's checks | Not reproduced by the door audit; seen twice near the notice board. Proposal 3 adds a "stops short" assertion to the doors audit so it fails loudly if it reappears. |

## Part 3 — Proposals (recommended priority order)

| # | Name | Type | Size | Depends on |
|---|---|---|---|---|
| 1 | Make this my home | new feature | M | — (migration #6) |
| 2 | Frame meter and chunked build instancing | performance | M | — |
| 3 | Tap-to-move takes the gaps you can walk | maintenance | S | — |
| 4 | Hip roofs with real tile courses | update | S | — |
| 5 | Letters and the Post House (House 3 opens) | new feature | L | home mailbox delivery needs #1; the rest is independent |
| 6 | Your home's guest book | update | S-M | #1 |
| 7 | Help build my home (helpers) | new feature | M | #1 (migration #7) |
| 8 | The Workshop never runs dry | update | S-M | — |
| 9 | Doors that close, and a latch for your home | update | M | #1; latch for helpers needs #7 |

### Parallel build map

Files each proposal writes (reads are free). Proposals whose rows share no file can be built at
the same time.

| File / area | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| `server/src/persistence/migrations.ts` | #6 | | | | | | #7 | | |
| `shared/src/protocol.ts` (additive) | x | | | | x | x | x | | x |
| new `shared/src/homes.ts` / `server/src/homes/` | x | | | | | x | x | | x |
| `shared/src/building.ts` | | | | | | | x | x | x |
| `server/src/building/index.ts` | x (clear-on-removal hook) | | | | | | x | x | x |
| `client/src/build/BuildUi.tsx` | x | | | | | | x | x | x |
| `client/src/build/BuildLayer.tsx` | | x | | | | | | | x |
| `client/src/build/meshes2.ts` | | | | x | | | | | x |
| `client/src/player/pathfinding.ts`, `navigation.ts` | | | x | | | | | | |
| `shared/src/world/{buildings,interiors,interactables}.ts`, `client/src/world/arch/*` | | | | | x | | | | |
| `server/src/interactions/index.ts` (mail) | | | | | x | | | | |
| `client/src/ui/panels/SimplePanels.tsx` (Home panel), `MapPanel.tsx` | x | | | | x (Home panel letters tab) | x | x | | |
| `client/src/ui/panels/SettingsPanel.tsx`, `client/src/game/perf.ts` | | x | | | | | | | |
| `shared/src/activities.ts`, `client/src/activities/Outdoor.tsx`, `Indoor.tsx` | | | | | x (station) | | | x | |

**Can run together this cycle without sharing files:** **1 + 2 + 3 + 4** (recommended set). **8**
can join it if it doesn't touch `BuildUi.tsx` (the locked-style hint can live in the style swatch
component only after #1 merges, or #8 goes second). **5** can run in parallel with **1** if the
`protocol.ts` additions are merged in order and the Home panel letters tab lands after #1.
6, 7 and 9 follow #1.

Ground rules for every proposal: real multiplayer only; server-authoritative; new player-written
text goes through `sanitizeText`/`sanitizeMultiline` + `filterText`/`maskProfanity`, is refused
while chat-muted, length-capped, rate-limited and reportable; procedural art only; desktop and phone;
zero console errors in browser runs; "twice in a row" = two consecutive green runs of the named
script on a quiet machine; new browser suites get their own default port and an entry in
`scripts/e2e-all.mjs`.

---

### 1. Make this my home

**Type:** new feature · **Size:** M · **Migration:** #6 (reserved)

**Player-visible result.** You build a house (walls, a doorway, a house roof), select one of its
pieces and choose **Make this my home**. Walking up to it shows "Fern Cottage · Ivy's home · 2
inside", using the name from your name sign if there is one, else "Ivy's home". The Home panel
stops saying "Not yet": it shows your home, a **Show my home on the map** switch (off by default),
**Move my home here** and **Stop calling this home**. With the switch on, the map shows a quiet pin.
If you take the house apart so it is no longer a house, the home is cleared and you get a notice.
The Gazette may record "Ivy made Fern Cottage their home" (a real event).

**Why now.** First in line from cycle 01. It is the owner's listed future feature ("A home of your
own"), and the Home panel is the last "Planned" screen. Decisions D1 and D3 make it buildable.

**Files / areas.**
- New pure `shared/src/homes.ts`: `houseFor(index, pieceId)`, which uses `enclosureAt`
  (`shared/src/buildEnclosure.ts`) to find the room, then requires ≥ 4 wall-type pieces of the
  requester incl. a doorway on its boundary and a `house_roof` (or legacy roof) of the requester
  over it. It returns `{ rect, doorPieceId, pieceIds, name? }`. The name is a name sign mounted on
  one of its walls.
- Migration #6: `homes (world_id, profile_id, door_piece_id, rect_json, show_on_map BOOLEAN,
  created_at, PRIMARY KEY (world_id, profile_id))` + a unique index on `(world_id, door_piece_id)`.
- New `server/src/homes/` service (RoomHooks, registered in `server/src/services.ts`): `set`,
  `clear`, `setPin`. All are owner-only and rate-limited (a new `home` rate-limit action in
  `CONFIG.rateLimits`). Building service hook: after any removal or admin removal that touches a
  home's pieces, re-check `houseFor` and clear the home if it no longer qualifies.
- Protocol (additive): `C2S.homeSet {pieceId}`, `C2S.homeClear`, `C2S.homePin {on}`;
  `S2C.homes` (pins + approach labels: profile id, name, door piece, rect, pinned) in the first
  build snapshot chunk; `S2C.homeChanged` deltas; `S2C.homeResult` to the requester. Not in the
  Colyseus schema.
- Client: `BuildUi.tsx` selection card button + `NamePrompt` text, `SimplePanels.tsx` `HomePanel`,
  `MapPanel.tsx` pins, `client/src/build/sync.ts` (homes list); debug section `snapshot().homes`.
- Memory: `home_made` event + Gazette template (once per profile per house).

**Risks.**
- Edge cases in "is this a house": a shared wall between two owners, an L house with two roofs, a
  two-storey house. `enclosureAt` already handles these, but every case gets a test.
- A home must never be left pointing at deleted pieces. The clear-on-removal hook covers player
  removal, cascades, admin removal and `adminRemoveProfile`.
- The name used on the pin and label comes only from the already-moderated name sign.

**Acceptance criteria.**
1. `shared/test/homes.test.ts`: a qualifying 4x4 hut; no doorway → refused; no roof → refused;
   someone else's roof over your walls → refused; L house (two roofs) → one home; the name comes
   from a name sign on the boundary; standing data identical to the server's.
2. `server/test/homes.test.ts`: one home per profile (setting a second moves it); a forged
   `homeSet` on another player's house or a non-house → refused with reason; removing a wall →
   home cleared + notice; admin removal of the profile's pieces → home cleared; `homePin` toggles;
   banned / build-banned owners' pins are not sent; migration #6 applies on a fresh DB and on a DB
   migrated 1-5 (persistence test).
3. `npm test`, `npm run typecheck` green.
4. `npm run e2e:homes` (new suite, own port `HOMES_PORT` 2644, fresh data dir; desktop A + touch
   phone B), green twice in a row:
   1. A builds a hut through the real UI and makes it home.
   2. B walks up and sees the "· A's home" label.
   3. The map pin is absent by default; after A switches it on, B's map shows it.
   4. A removes the roof: the home is cleared on both and A gets a notice.
   5. A re-roofs and re-homes. After a server restart, home and pin are intact and a late joiner
      sees the label.
   6. A forged `homeSet` from B is refused.
   7. Zero console errors.
5. Still green via `npm run e2e:all`: build, build2, combined, built-interiors, roofs, phone.

---

### 2. Frame meter and chunked build instancing

**Type:** performance · **Size:** M

**Player-visible result.** With many houses on the island, frames are cheaper wherever you look:
build pieces far off-screen stop being drawn. In Settings → Graphics a small **Performance** line
shows frames per second, frame time (typical / slow) and draw calls. That is what lets someone with
a real phone report real numbers later (the owner-reserved real-device check).

**Why now.** The cycle 01 vetting found the real lever. Each build instancing group calls
`mesh.computeBoundingSphere()` over all its instances (`client/src/build/BuildLayer.tsx` ~l.388),
so a kind spread across the island is never frustum-culled: 2,000 pieces cost 0.70 M triangles
wherever the camera looks. Homes (#1) will bring more building. Stairs (cycle 03) was made
conditional on a frame meter.

**Files / areas.**
- `client/src/build/BuildLayer.tsx`: groups keyed by kind + variant + material bucket **+ spatial
  chunk** (e.g. 24 m cells, the same idea as the town's chunked `Architecture.tsx`), each with its
  own bounding sphere. The chunk size is a constant chosen from measurements (calls against
  triangles).
- `client/src/game/perf.ts`: a production-safe frame-time ring buffer (p50/p95 over the last ~300
  frames) and renderer info (calls, triangles) published as `snapshot().frame`. This is available
  in production builds, unlike `__ELSEWHERE_WORLD__.info()`, which is dev-only (`World.tsx` l.98).
- `client/src/ui/panels/SettingsPanel.tsx`: one quiet line under Graphics.
- New `scripts/perf-baseline.mjs` (production build via `scripts/lib/server.mjs`): seeds the
  2,000-piece mix with `scripts/build-scale.mts`, then reads `snapshot().frame` and
  `snapshot().buildRender` at fixed views and `?time=` values. It writes
  `docs/perf/baseline.json` and exits non-zero if calls or triangles regress by > 10% against the
  committed baseline.
- No adaptive quality yet (shader recompiles would hitch weak devices; it waits for real-device
  numbers).

**Risks.** More groups means more draw calls when everything is on screen. The acceptance numbers
bound it. Chunk boundaries must not break the per-instance `aFade` / `aCut` updates or picking
(`picking.ts`).

**Acceptance criteria.**
1. Before numbers recorded first (unchanged build, same script): for the 2,000-piece world at three
   views (default spawn, Town Square, a corner of the island away from the pieces), build-layer
   calls and triangles plus whole-frame `snapshot().frame` calls/triangles.
2. After:
   - At the corner view, build-layer triangles drop by ≥ 60%.
   - At the default view, build-layer triangles drop by ≥ 25% and whole-frame draw calls rise by
     ≤ 15%.
   - At the view that shows the most pieces, draw calls rise by ≤ 25%.
   - All numbers are committed in `docs/perf/baseline.json` and the README "Player building"
     measurements.
3. `client/test/buildChunks.test.ts` (new): chunk assignment is stable; a piece moved by
   remove + place lands in the right chunk; fade and cut attributes are found for every id after
   re-chunking.
4. `snapshot().frame` exists in a production build (checked by the baseline script) and the
   Settings line renders on desktop and phone (screenshot).
5. Still green: built-interiors (cutaway and picking through cut walls), build, build2, roofs,
   combined via `e2e:all`; `npm test`, typecheck.

---

### 3. Tap-to-move takes the gaps you can walk

**Type:** maintenance · **Size:** S

**Player-visible result.** Tapping a spot on the far side of the House 1 / House 2 gap walks you
straight through the gap, the way the joystick already can, instead of a long detour round
House 1. The same goes for other narrow but walkable gaps (between built houses, fences and props).

**Why now.** Found by the cycle 01 door audit, with a repro command in the backlog. Homes will put
more people in the Residential District and between built houses, where narrow gaps are common.

**Files / areas.** `client/src/player/pathfinding.ts` (`NavGrid`: 0.5 m cells, `isWalkable` with a
0.1 m clearance margin on top of the 0.4 m radius). The likely cause is cell-centre sampling
rounding a gap of ~0.9-1.1 m closed. Fix: a finer cell or corner-aware sampling inside a
bounded rectangle around narrow gaps, or a "gap pass" that tests the true swept circle with
`resolveMovement` between cell centres. Plus `navigation.ts` if the path smoothing needs it, and a
"stops short" check in `scripts/e2e-doors.mjs` (stop > 1 m from the goal with the path ended →
reported per route).

**Risks.** A finer grid costs memory and A* time. The bound: grid build time and path time stay
under today's numbers × 1.5 (measured in the unit test). A gap the grid opens must really be
walkable, so the test checks the path with `resolveMovement`.

**Acceptance criteria.**
1. `client/test/navGaps.test.ts` (new):
   - The path from the repro start to the House 2 apron goes through the House 1 / House 2 gap. Its
     length is within 15% of the straight-line distance, and every segment is walkable by
     `resolveMovement` (no correction).
   - A synthetic 0.95 m gap between two built walls is pathable; a 0.7 m gap is not.
   - Grid build and path time are recorded and within bounds.
2. `npm run e2e:doors -- --doors house_2 --spawns 2` reports no detour on that route. A full
   `npm run e2e:doors` reports no new detours or stalls, and "stops short" is zero.
3. `node scripts/e2e-player.mjs` (click/tap-to-move, collision) still green; `npm test`, typecheck.

---

### 4. Hip roofs with real tile courses

**Type:** update · **Size:** S

**Player-visible result.** Hip roofs on player houses get the same scalloped tile courses, ridge
caps and overhanging eaves as gable roofs, so a hip-roofed cottage looks as finished as the town's
houses. Today it is a plain four-faced pyramid (`docs/screenshots/build/house-hip-*`).

**Why now.** Owner feedback asked for "proper sloped roofs". This is stage 1 of the staged roof
work from cycle 01 and was recommended as filler.

**Files / areas.** `client/src/build/meshes2.ts` only (`houseRoof`, which today calls the town kit's
`pavilionRoof` for hips): a hip generator that lays tile courses on each trapezoid/triangle facet,
hip-ridge caps along the four hips and the same eaves as `roof(...)`. Same params, so no data or
server change. Palette thumbnails update automatically (`thumbnails.ts` renders the real
templates).

**Risks.** Triangle count. Today a hip is 854 triangles against 3,232 for a 4x6 gable. The cap is
≤ the gable's count at the same size.

**Acceptance criteria.**
1. `client/test/hipRoof.test.ts` (new):
   - For sizes 2x2 to 12x12 and both pitches: the geometry is watertight on each facet (no gaps
     at the hips: shared edge vertices within 1 mm).
   - The top is at `roofRise` from `shared/src/building.ts`.
   - Triangles ≤ the same-size gable.
2. Before/after screenshots with `node scripts/build-screenshots2.mjs` (the house-hip day/night,
   desktop and phones), reviewed against the gable house (`house-gable-vs-town-*`).
3. README triangle table updated with the new hip count; the "hip roof plainer" limitation removed.
4. `npm run e2e:roofs` and `npm run e2e:build2` still green; `npm test`, typecheck.

---

### 5. Letters and the Post House (House 3 opens)

**Type:** new feature · **Size:** L

**Player-visible result.** House 3 in the Residential District opens as **the Post House**: a
small walk-in room with a writing desk, a counter and a wall of pigeonholes. At the desk you write
a letter (up to 400 characters) to any resident: pick from people you've met (shown in your chat
log or the player list this session) or from homes on the map. You can also choose "Write a letter"
on the player card of someone you can see. The recipient's pigeonhole fills up. When they next pass
the Post House, or open their home mailbox if they have a home (#1), they read it. Only they can.
They can delete it or report it. A small "1 letter" mark appears on your Home button when
something has arrived.

**Why now.** Decisions D1 and D2: House 3 is the first public house, and the home mailbox is a
private letterbox. "A mailbox that's yours" is the Home panel's promise. The Post House means
players without a home get letters too.

**Files / areas.**
- World data:
  - `shared/src/world/buildings.ts`: `house_3` becomes `enterable: true`, `futureHome: false`,
    name "The Post House". Keep the 6 x 5.5 m footprint (do **not** grow it like `home()` does),
    so the protected zone around it does not swallow existing player pieces.
  - `shared/src/world/interiors.ts`: an interior with anchors entrance / desk / counter /
    pigeonholes, furniture, seat ids.
  - `interactables.ts`: two stations (desk, pigeonholes).
  - `client/src/world/arch/walkin.ts` + `furniture.ts`.
  - `shared/test/interiors.test.ts` reachability: new rows. Add a test that this is the only
    data-hash change (`worldDataHash` changes, so `scripts/server-integration.mjs`'s fingerprint
    must be refreshed).
- Mail (new code, not a reuse):
  - Letters are stored in the existing `mail_notes` table with `mailbox_id = 'letters:<profileId>'`,
    so no migration is needed. The server never serves these through public-mailbox reads.
  - New `C2S.letterSend {to: profileId, text}`, `C2S.letterList`, `C2S.letterDelete {id}`,
    `C2S.letterReport {id}`; `S2C.letters`; `S2C.letterArrived` (count only) to the recipient if
    online.
  - Rules in `server/src/interactions/index.ts` or a new `server/src/letters/`:
    - in range of the desk or the target's player card (recipient within chat proximity);
    - `isBlockedBetween` checked **on send**;
    - chat-mute pauses writing;
    - sanitize + filter + 400 cap;
    - per sender: 5 letters per real day and 1 per recipient per real day;
    - recipient inbox capped at 50 (oldest read letters dropped first).
- Home mailbox (only after #1 lands): a mailbox mesh by the home's door, resolved like built seats.
  **Note:** `registerInteractableResolver` holds a single function
  (`shared/src/world/interactables.ts` l.435) and building already registers one, so the work must
  turn it into a chain rather than replacing it.
- Client: letter panel (Sheet with peek), PlayerCard "Write a letter", Home panel "Letters" tab,
  Home button badge.
- Memory: none about letters' contents. "The Post House opened" is not an event (it is a deploy, not
  a player action).

**Risks.**
- Harassment by mail. Covered by the send-side block, daily caps, reports, recipient deletion and
  the moderator view (`GET /api/admin/letters?profile=` added to `admin.ts`, mirroring notes).
- Data-hash change affects `server-integration`.
- The interior must not break any existing e2e that walks the Residential District.

**Acceptance criteria.**
1. Unit (shared): Post House anchors reachable from every spawn through its door; seats exit
   cleanly; no other building's data changed (hash of the other buildings stable).
2. Unit (server, `server/test/letters.test.ts`):
   - only the recipient lists and reads; a blocked sender is refused on send;
   - daily and per-recipient caps; chat-muted sender refused;
   - profanity masked, HTML shown as text;
   - delete by the recipient only; report creates a report with the letter as evidence;
   - public mailboxes never return `letters:` notes, even with a forged `mailboxId`.
3. `npm run e2e:letters` (new, `LETTERS_PORT` 2645, desktop A + phone B), twice in a row:
   1. A walks into the Post House by tap-to-move.
   2. A writes to B from the desk; B gets the arrival mark.
   3. B reads it at the pigeonholes.
   4. C, a third page (a guest), cannot read it via forged messages.
   5. B blocks A; A's next letter is refused with a visible reason.
   6. Restart: the letter is still there.
   7. If #1 has landed: B makes a home and reads the letter at the home mailbox.
   8. Zero console errors.
4. Still green: interiors, activities, combined, doors (the Post House door added to the audit),
   acceptance; `server-integration` with the refreshed fingerprint.

---

### 6. Your home's guest book

**Type:** update · **Size:** S-M · **Depends on:** #1

**Player-visible result.** Every home has a guest book on a little stand inside the door. Visitors
sign it once a day (120 characters). The owner can take down any entry in their own book (new: today
only the author can, `server/src/activities/index.ts` `removeEntry` l.511), and anyone can report one.
The Home panel shows your latest signatures. Signing someone's book is how you say "I visited".

**Why now.** It turns a home into a place people visit and leave a trace, which is half of what
"Make this my home" was proposed for. It was staged after #1 by the cycle 01 vetting.

**Files / areas.**
- Entries reuse table `activity_notes` with `board_id = 'home:<profileId>'` and the existing
  repository functions.
- Entries are **not** synced through `state.activities` (that is per-world room state). The book is
  fetched on open (`C2S.homeBook {owner}` → `S2C.homeBook`) and pushed to people inside that home
  on change.
- Owner removal and send-side block checks are new code in `server/src/homes/`. Same text rules as
  House 1/2 books (one per profile per book per world-day, `sanitizeMultiline` + `maskProfanity`,
  chat-mute pauses writing).
- Client: a stand mesh placed automatically inside the doorway (render-only, not a piece), the panel
  (reuses the guest-book panel UI from `client/src/activities/Panels.tsx` in a new wrapper), and the
  Home panel section.

**Risks.** The automatic stand must not block movement or overlap furniture: it is render-only,
with no collider, at a fixed spot on the doorway's inside. Data for removed homes: entries are kept
but hidden, and come back if the home is re-made on the same house (the 72 h purge is the existing
notice job; guest-book entries never expire today, which stays as is).

**Acceptance criteria.**
1. Server unit tests:
   - a visitor signs once per world-day;
   - the owner removes any entry, while a non-owner non-author cannot;
   - a blocked player cannot sign (refused with reason);
   - the profile's entries in other books are unaffected;
   - nothing about home books appears in `state.activities` (asserted on the room state).
2. `npm run e2e:homes` gains checks:
   1. B signs A's book and A sees it live.
   2. A takes it down and B sees it gone.
   3. A blocks B, and B's next signing is refused.
   4. Restart: entries persist.
3. Zero console errors; `npm test`, typecheck.

---

### 7. Help build my home (helpers)

**Type:** new feature · **Size:** M · **Depends on:** #1 · **Migration:** #7

**Player-visible result.** From the Home panel, or from someone's player card while you are in your
home, you choose **Invite to help build**. Your friend gets a notice ("Ivy invited you to help build
Fern Cottage", accept / decline). Once they accept, they can place pieces inside your home and on
your walls: a second storey, furniture, a roof. Their pieces show "added by Wren" when selected.
You can remove anything in your home. Uninvite at any time.

**Why now.** Decision D5. It answers the regular's "things to do with others" in the place the
owner cares most about (building) without loosening the global anti-pinning rule.

**Files / areas.**
- Migration #7: `home_helpers (world_id, owner_profile_id, helper_profile_id, accepted_at,
  PRIMARY KEY (world_id, owner_profile_id, helper_profile_id))`.
- `shared/src/building.ts`:
  - `validatePlacement` ctx gains `canBuildOn(ownerId)`. Supports may belong to the requester **or**
    to an owner who invited the requester, but only for placements inside that owner's home rect
    + 1 m.
  - `cascadeRemoval` / remove rules: an owner removing an owner piece inside their home also
    removes helper pieces resting on it.
  - The owner may remove helper pieces in the home.
  - Unchanged everywhere else.
- `server/src/building/index.ts` (place/remove checks with the helper relation),
  `server/src/homes/` (invite, accept, decline, uninvite; blocking either way uninvites;
  ≤ 4 helpers per home; invites expire after 24 h).
- Protocol additive (`homeInvite`, `homeInviteAnswer`, `homeUninvite`, `S2C.homeInvite`).
- Client: `BuildUi.tsx` selection card ("added by …", Remove for the owner), Home panel helpers
  list, PlayerCard action, notice toast.

**Risks.**
- This touches the support/removal rulebook that every placement uses. The unit tests must show
  identical results for every existing test case when no helper relation exists (run the existing
  `shared/test/building*.test.ts` unchanged).
- Anti-pinning, tested explicitly: no sequence of helper actions can make an owner's removal fail.

**Acceptance criteria.**
1. `shared/test/helpers.test.ts`:
   - a helper builds on the owner's wall inside the home → ok;
   - the same helper outside the home rect → refused;
   - a non-helper → refused;
   - owner removes a supporting wall → the helper's dependents cascade;
   - a helper removing an owner piece → refused;
   - a property test of random helper place sequences, where the owner can always remove every one
     of their own pieces;
   - every existing building test unchanged and green.
2. Server tests: invite / accept / decline / expire; block uninvites; cap of 4; forged placement as
   a non-helper refused; pieces of an uninvited helper stay and are still removable by the owner.
3. `npm run e2e:homes` gains checks:
   1. A invites B by the player card; B accepts on the phone.
   2. B builds a second-storey wall and a chair inside A's home; A sees both.
   3. A removes the wall under B's wall, and both disappear on both clients; B gets a notice.
   4. A uninvites B, and B's next placement there is refused with a visible reason.
   5. Restart: the relation and pieces persist.
4. Zero console errors; `npm test`, typecheck.

---

### 8. The Workshop never runs dry

**Type:** update · **Size:** S-M

**Player-visible result.** After the lanterns, the weather vane and the bunting, the Workshop keeps
going. Three more town projects change the island for good:
- flower boxes on the Town Hall windows;
- a bench circle at the waterfront;
- lanterns along the Mossy Bridge.

After those, a fourth project, **"Glazes for the kiln"**, unlocks two glazed roof colours and two
painted wall colours for everyone's house roofs and walls. Until then those swatches show greyed:
"Made at the Workshop: stage 1 of 3". The Gazette names who did the work.

**Why now.** Today Bram says "Every project on the list is done. More are coming." (activities.ts
l.477), a dead end in a building the owner asked to have things going on in. It also delivers
progression without currency (D4). Unlocking **colours of existing pieces** avoids the new-mesh art
cost that deferred the cycle 01 version.

**Files / areas.**
- `shared/src/activities.ts`: `PROJECTS` gains entries; `ProjectDef.unlocks?: { variants: { kind,
  variant }[] }`.
- `client/src/activities/Outdoor.tsx`: three outcome models, procedural, in the town kit's style,
  each with a triangle budget.
- `shared/src/building.ts`: the variant catalog entries flagged `unlockedBy`; `validatePlacement`
  ctx gets the unlocked set; existing variants are never gated.
- Server: `server/src/activities/` project completion pushes the unlocked set to building (project
  completion is already persisted in world kv: `completed[]`). Unlocked set in the first snapshot
  chunk + `S2C.buildUnlocked`.
- Client: the style swatch shows the locked state. This is the only `BuildUi.tsx` touch, kept in
  the swatch component; merge after #1.
- Anti-farming: only profiles at least `WORKSHOP_MIN_PROFILE_AGE_MINUTES` old (default 30, env
  override; set to 0 in `e2e:activities` / combined via their env so today's suites are unchanged)
  count towards the distinct-player threshold.

**Risks.** Outcome art quality against the craft bar, and the triangle budget (keep the three
outcomes ≤ 20 k triangles total, measured). The anti-farming rule could change today's behaviour;
the env override and its default must be listed in README.

**Acceptance criteria.**
1. `shared/test/activities.test.ts`-style new file `shared/test/workshopUnlocks.test.ts`:
   - project order;
   - a locked variant is refused with reason `locked` and a visible text, and accepted after
     unlock;
   - every pre-existing variant is never gated.
2. Server tests:
   - completion unlocks across room instances and survives restart;
   - a forged placement of a locked variant is refused;
   - profiles younger than the threshold don't count as distinct, and do count with the env at 0.
3. A new check in `e2e:activities` (lowered `WORKSHOP_STAGE_*`, `WORKSHOP_MIN_PROFILE_AGE_MINUTES=0`):
   1. A and B finish the next project, and the outcome appears outdoors on both.
   2. After the glaze project, both palettes show the new swatches, B places a roof in a glazed
      colour, and A sees it.
   3. Restart: still unlocked.
4. Screenshots of each outdoor outcome by day and night; triangle numbers in README.
5. `npm test`, typecheck; `e2e:activities`, `e2e:combined` green via `e2e:all`.

---

### 9. Doors that close, and a latch for your home

**Type:** update · **Size:** M · **Depends on:** #1 (latch); helpers' access needs #7 · **Migration:** none (door state in the piece's existing `params`)

**Player-visible result.** A **Door** piece hangs a painted door leaf in one of your built doorways.
Walk up and press E (or click it) to open or close it. It swings like the town's doors and closes by
itself after a while. A closed door blocks walking through like a wall. On your home you can
**latch** it: then only you and your helpers can open it from outside, and others see "Latched — Ivy's
home". From inside, anyone can always open it. Town building doors are unchanged and never block.

**Why now.** Decision D6. Privacy makes a home feel like a home. The no-trap guarantee (exit is
unconditional, Unstuck always works) keeps it safe.

**Files / areas.**
- `shared/src/building.ts`: a `door` piece (mount on a doorway; one per doorway; no text).
  `pieceColliders` gains a closed-leaf collider that is added to or removed from the shared dynamic
  collision layer by state, on server and client alike.
- Door state (open/closed, latched) lives in server memory and is persisted as the piece's
  `params` (`build_pieces.params` already exists), so no migration is needed. It is broadcast as
  `S2C.buildUpdated`.
- `server/src/building/index.ts`:
  - open/close via the built-piece interact route (`bp:` ids, like built seats);
  - latch is owner-only;
  - opening from inside is always allowed. "Inside" is the side of the doorway facing the home's
    enclosure, computed by `enclosureAt`; for non-home doors both sides may open.
  - A closed door auto-opens when anyone inside walks into it (server-side, in the move handler's
    collision step for that collider only).
- Client: `meshes2.ts` (door leaf), `BuildLayer.tsx` (swing animation), prompt text, `BuildUi.tsx`
  (Latch toggle on the selection card).

**Risks.**
- Trapping. Answered by the unconditional exit plus Unstuck, and tested in a browser.
- A dynamic collider toggling while a player stands in the doorway: refuse closing while anyone
  overlaps the leaf. This is the same rule as "a solid piece over any player".
- Pathfinding: a closed door is treated as blocked for strangers and as open for the owner and
  helpers when the door is unlatched. `refreshNavRect` on state change.

**Acceptance criteria.**
1. Unit (shared/server):
   - a closed door blocks `resolveMovement` from both sides; an open door doesn't;
   - closing with a player in the doorway → refused;
   - latch is owner-only;
   - from inside, a non-owner opens a latched door → ok; from outside → refused;
   - Unstuck from inside a latched home works;
   - town doors are unaffected (existing tests unchanged).
2. A property test: for random sequences of open / close / latch / place / remove by the owner,
   every player inside an enclosure can reach outside without Unstuck.
3. `npm run e2e:homes` gains checks:
   1. A hangs a door and closes it, and B is blocked (server positions).
   2. A latches it: B can't open it from outside (visible "Latched" text), while a helper (if #7)
      can.
   3. B, already inside when it was latched, walks out by opening the door from inside.
   4. Restart: the door state persists.
4. `e2e:combined` (doors of town buildings cannot be sealed) still green; zero console errors.

---

## Parked or not proposed this cycle

| Idea | Type | Why |
|---|---|---|
| Stairs and walkable upper floors | update | Cycle 03, after the frame meter (#2); hard requirements unchanged. |
| Joined L roofs (stage 2) | update | After hip tile courses (#4); give the reworked roof tool a cycle. |
| Legacy roof tile migration | maintenance | Rewrites players' data for a cosmetic gain; after joined roofs. |
| Adaptive quality step-down | performance | Needs real-device numbers from #2's meter (owner-reserved check). |
| Garden plots (House 4 or 5 as the Seed House) | new feature | Strong candidate for the next public house (D1). |
| Display curiosities on built shelves | new feature | Follows homes; good after #1. |
| A gentle currency | new feature | D4: none for now; revisit with trading. |
| Claimable starter cottage | new feature | Rejected by D1 (no fair allocation). |
| World-wide online count | update | Still a good chore (instances share one process; `roomRegistry`). |
| Shared rain and snow | update | After #2's meter. |
| Keepers walk home and talk among themselves | update | After #2's meter. |

## Recommended priority (summary)

1. Make this my home (new feature, M, migration #6)
2. Frame meter and chunked build instancing (performance, M)
3. Tap-to-move takes the gaps you can walk (maintenance, S)
4. Hip roofs with real tile courses (update, S)
5. Letters and the Post House (new feature, L)
6. Your home's guest book (update, S-M, after #1)
7. Help build my home (new feature, M, after #1, migration #7)
8. The Workshop never runs dry (update, S-M)
9. Doors that close, and a latch for your home (update, M, after #1)

Recommended parallel set for this cycle: **1 + 2 + 3 + 4**. They share no files: #1 writes the
server, migrations, protocol and `BuildUi.tsx`; #2 writes `BuildLayer.tsx`, `perf.ts` and
Settings; #3 the pathfinder; #4 `meshes2.ts`. Add **8** as a second wave after #1 merges
(`BuildUi.tsx` swatch).
