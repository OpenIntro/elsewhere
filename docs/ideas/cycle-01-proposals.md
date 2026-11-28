# Cycle 01 — Ideas committee proposals

Date: 2026-11-27. Grounded in README.md, docs/ARCHITECTURE.md, `shared/src` (config, building,
activities, world/), the server/client module layout, and the screenshots in `docs/screenshots/`
(world, interiors, activities, build, combined, ui, acceptance).

## What we looked at

- **What it is today.** A warm, clay-and-painted-wood island seen from an orthographic iso camera.
  Seven walk-in buildings with keepers and shared activities (piano, notices, poll, workshop project,
  hearths, nets), a Gazette written only from real events, and outdoor player building with
  house roofs, stacking, name signs and ~50 furniture kinds.
- **What the screenshots show.** The town buildings and the player cottages already sit together
  well (`build/house-gable-vs-town-*`). Weak spots are visible: the L-shaped house is two roofs
  crossing (`build/house-L-day-desktop.jpg`), the player-built interior reads as a dotted ghost
  (`build/interior-day-desktop.jpg`), the landscape build dock covers roughly the bottom 45% of the
  phone (`build/palette-phone-landscape.jpg`), and the café piano sheet covers the lower half of the
  room on a phone (`activities/cafe-night-phone.jpg`).
- **Owner signal, in order.** Premium handcrafted miniature that feels alive → real multiplayer
  only → walk into buildings → things going on inside → actually build → roofs, clearing, stacking,
  signs, more to put inside → continuous improvement. Building is where the owner has spent the most
  attention.
- **Scope update from the owner (mid-cycle).** Ideas may be new features, updates to existing
  features, or performance/maintenance work. The final eight are a deliberate mix: 2 new features,
  4 updates, 1 performance, 1 maintenance (see the table).

## The committee

| Seat | Cares about |
|---|---|
| **New** — a new player in their first ten minutes | knowing what to do, seeing the world, not fighting the UI on a phone |
| **Regular** — builds, wants reasons to return and things to do with others | depth, ownership, progress, people |
| **Art** — world/art director | cohesion, beauty, the miniature look, restraint in UI |
| **Eng** — engineer | performance, server authority, testability, scope |
| **Mod** — community/moderation lead | griefing, abuse, text, harassment, honesty rules |

## Raw brainstorm (37 ideas)

Building depth: (1) stairs and walkable upper floors; (2) one roof for L/T/U-shaped houses with
real valleys; (3) hip roofs with proper tile courses; (4) a move tool (pick up and set down a piece
instead of remove + place); (5) repaint a placed piece's style; (6) blueprints — save a house and
rebuild or share it; (7) garden paths and stepping stones as a build layer; (8) transparent window
glass from outside; (9) doors that close and block (and optionally lock).
Things to do together: (10) garden plots — plant the store's seed packets, neighbours water them
over real days; (11) event listings on the notice board with a world-clock time and "I'll come";
(12) co-building permission (let a friend build on your house); (13) fishing off the dock;
(14) a music jam — the tin whistle and the record player playable like the piano; (15) hand a
curiosity to another player (gifts).
World life and atmosphere: (16) shared rain and snow (now placeholders); (17) keepers step out at
closing time and walk home through town, and talk to each other in labelled lines; (18) more small
ambient life (cats, ducks on the creek); (19) a dusk lantern festival on the dock when enough
real players gather.
Homes and ownership: (20) make a house you built your home (mailbox, guest book, map pin);
(21) open houses 3-5 as claimable homes; (22) neighbourhood street-name signs.
Progression without a pay economy: (23) Workshop projects that unlock new building pieces for
everyone; (24) a personal builder's notebook of real milestones; (25) display curiosities on built
shelves.
Onboarding and discoverability: (26) a first-day postcard checklist (sit, ring the bell, visit the
café, place a piece); (27) named player houses on the map so people can visit; (28) a guided
"first hut" build.
Mobile usability: (29) a compact phone build dock; (30) peek-height activity sheets that leave the
room visible.
Social tools: (31) opt-in friends and "where is my friend" on the map; (32) "walk with" (follow a
friend); (33) photo mode.
Performance / quality: (34) in-game frame meter + adaptive quality + triangle trims; (35) code
splitting / bundle size; (36) a world-wide online count across room instances.
Robustness / maintenance: (37) one e2e harness for the six browser suites (faster, steadier, plus a
repro for the phone tap-to-move stall to the Town Hall); also: real-Postgres test run, migrating
legacy roof tiles, a readable interior for player-built houses (cutaway).

## How the debate went (short)

- **Regular** pushed hard for stairs and a home of your own: "my two-storey house is a stage set; I
  can't go upstairs and nobody can find it." **Eng** called stairs the riskiest item on the list
  (2D collision, server movement validation and the pathfinder all assume one ground level) and
  wanted it split behind a flag; it survived as a large item with a strict scope (player-built
  stairs only, town buildings excluded).
- **Art** argued for rain and snow ("alive" is the owner's first word), and against anything that
  adds HUD. **Eng** answered that frame rate has never been measured on a real GPU and that weather
  particles on phones should wait until there is a frame meter and adaptive quality. Weather was
  parked to the top of the next cycle, with Art dissenting.
- **New** wanted the first-day postcard checklist; **Art** and **Regular** felt it risks a
  "quest log" feel, and **Mod** noted nothing is broken there yet. Parked.
- **Mod** blocked co-building and lockable doors in this cycle: both change who can trap or pin
  whom, and both overturn rules the owner's builds already rely on (upper pieces only on your own
  pieces; Unstuck always works). They go to "needs the owner".
- Garden plots lost narrowly to Workshop unlocks: both are "together" features, but the Workshop
  goes idle after its three projects today ("Every project on the list is done. More are coming."),
  so unlocks fix a dead end as well as adding something new.
- **Eng** insisted on one maintenance item: six browser suites, each spawning its own server, that
  time out when run together, are now the main cost of every change. Everyone agreed after Mod
  pointed out the unexplained phone stall needs a repro somewhere.

## Ranked proposals

| # | Name | Type | Size | Fixes a known weak point | Can start in parallel |
|---|---|---|---|---|---|
| 1 | Your house, your home | new feature | M | homes are a "future feature" | yes |
| 2 | Stairs and walkable upper floors | update | L | upper storeys are visual only | after #3 lands, or same worker |
| 3 | Built interiors you can read | update | M | dotted cutaway in small built rooms | yes |
| 4 | A phone that shows the world | update | S-M | landscape dock and bottom sheets cover the screen | yes |
| 5 | Frame budget and adaptive quality | performance | M | frame rate never measured; ~0.8-1.2 M triangles | yes |
| 6 | The Workshop makes new pieces | new feature | M | Workshop idles after 3 projects; no progression | yes |
| 7 | One roof for L, T and U houses | update | M-L | L roofs overlap; hip roofs plain | yes |
| 8 | One harness for the browser suites | maintenance | M | slow/flaky e2e; unexplained phone tap stall | yes (see notes) |

Migration numbering: #1 and #6 may each add a migration (next is #6). Whoever merges second
renumbers; migrations are ordered and idempotent (`server/src/persistence/migrations.ts`).

---

### 1. Your house, your home

**Type:** new feature

**Pitch.** Once you have built a house with walls, a doorway and a roof, you can say "Make this my
home". Your house gets a small mailbox by the door that receives the same letters the town
mailboxes do, a guest book inside that visitors can sign, and a pin on the island map:
"Fern Cottage · Ivy's home". Walking up to it shows "Ivy's home · 2 inside". The Home panel, which
today says "Not yet", shows your home, its guest book and your mail. One home per player; you can
move your home to another house you built.

**Why now.** The owner asked for building, then for name signs on player buildings — they want
player houses to be places, not props. "A home of your own" is listed under Future features and
the Home panel is labelled "Planned". It also gives regulars a reason to return (letters, guest
book) and new players a way to find other people's houses (map pins).

**What it touches.**
- `shared/src/building.ts`: a pure `houseAt(index, pieceId)` / `homeEligible(...)` (owner's walls
  ≥ 4 incl. a doorway, under a `house_roof`), reusing the structure detection the server already
  does for `structure_roofed` / `building_named` (`server/src/building/index.ts`).
- New persistent state: migration `homes (world_id, profile_id, door_piece_id, name, created_at,
  PK (world_id, profile_id))`; repository in `server/src/building/repository.ts`.
- Protocol (additive, `shared/src/protocol.ts`): `C2S.homeSet {pieceId}`, `C2S.homeClear`;
  `S2C.homes` in the first build snapshot chunk + `S2C.homeChanged` deltas (not in the Colyseus
  schema, same reasoning as pieces).
- Mail: a home mailbox is an extra interactable resolved like built seats
  (`registerInteractableResolver`, id `home:<profileId>`), routed into the existing mail service.
- Guest book: reuse the activities guest-book logic with board id `home:<profileId>` (limits,
  filters, owner removal and reports already exist in `server/src/activities/`).
- Client: `client/src/build/BuildUi.tsx` (selection card "Make this my home"), `BuildLayer.tsx`
  (mailbox mesh by the door), `client/src/ui/panels/MapPanel.tsx` (pins), `SimplePanels.tsx`
  (Home panel), door prompt text.
- Memory/Gazette: `home_made` event ("Ivy made Fern Cottage their home") — real events only.
- Removing a wall/roof that makes the house ineligible clears the home with a notice to the owner.

**Size / main risk.** M. Risk: "is this a house?" is a heuristic over loose pieces; edge cases
(two houses sharing walls, a roof over someone's walls) must be pinned by tests, and the home must
be cleared, not left dangling, when pieces are removed.

**Abuse and mitigation.** Guest-book spam / slurs → existing guestbook rules (one signature per
profile per book per world-day, length cap, sanitize + profanity mask, chat-mute pauses writing,
owner removal, report). Blocked players cannot sign your book or send you mail (server-enforced,
existing block relation). Home names come from the already-moderated name sign; map pins of banned
or build-banned profiles are hidden. Map pins reveal where someone's house is — it is already
visible in the world, but a player can choose "don't show on the map".

**Verification.** Unit: eligibility (shared), one home per profile, clear-on-removal, blocked
player refused (server). Two browsers: A builds a hut, makes it home; B sees the pin on the map,
walks there, signs the guest book and posts a letter; A sees both; server restart; both still
there; a forged `homeSet` on B's house or on a non-house is refused.

**Dependencies / conflicts.** Independent. Touches `BuildUi.tsx` (also #4, #6, #7) — small,
separate sections; merge carefully. Migration number shared with #6.

**Verdicts.**
- New: "Yes — a map with real people's houses on it is the first thing that makes me want to walk somewhere."
- Regular: "Top pick. Mail and a guest book on my house are reasons to log in tomorrow."
- Art: "Yes, if the mailbox is a proper little painted-wood piece and the map pins stay quiet."
- Eng: "Fine. Reuses mail and guest-book code; keep homes out of the Colyseus schema."
- Mod: "Yes, with blocks enforced on mail and book, and an opt-out from the map."

---

### 2. Stairs and walkable upper floors

**Type:** update (player building)

**Pitch.** A new **Stairs** piece climbs one storey inside your house. Walk up it and you are on
your upper floor: the storey above you fades away, you can sit on the chair by the upstairs window,
and people outside see you at the window. Walk down and you are back on the ground floor. Clicking
a spot upstairs walks you there by the stairs.

**Why now.** Wall stacking and storeys were the owner's own feedback ("easier wall stacking") and
the result is two-storey houses players cannot go into. It is the top weak point from QA:
"players cannot walk upstairs in player-built or town buildings (upper storeys visual only)", and
built chairs upstairs cannot be sat on.

**What it touches.**
- `shared/src/building.ts`: `stairs` piece (2 x 3 m, rises one storey, needs a floor above at its
  top edge, own pieces only), `walkSurfaceAt` extended to upper floors reached by stairs, upper-level
  colliders from `pieceColliders` per level, and "edge of an upper floor is a wall" so nobody walks
  off into the air.
- `shared/src/collision.ts`: a level argument for queries (level 0 behaviour unchanged).
- `server/src/rooms/schema.ts` + `PlayerStateView`: append `level` to the player state; server
  `handleMove` validates level changes only via a stairs piece; reconnect resume keeps the level.
- Client: `player/LocalPlayer.tsx`, `pathfinding.ts` / `navigation.ts` (one NavGrid per level for
  built houses, joined at stairs), `build/BuildLayer.tsx` fade "above my level" instead of "near
  me", `meshes2.ts` stairs mesh, remote characters' y.
- Removal rules: stairs or an upper floor with a player standing on it cannot be removed;
  moderator removal moves them down first; Unstuck always works.
- Out of scope: town buildings' upper storeys (they have no interior upstairs).
- Behind a server flag `BUILD_UPSTAIRS` (on by default once green) so it can be switched off.

**Size / main risk.** L. Risk: touches shared collision and server movement validation used by
every player every tick; a regression breaks movement everywhere. Mitigation: level 0 code path
byte-for-byte unchanged, a property test that random level-0 moves give identical results before
and after, and the flag.

**Abuse and mitigation.** Trapping someone upstairs by removing the stairs → removal refused while
anyone is on the stairs or upper floor; Unstuck always available. Climbing into someone else's
house is no different from walking in their door today. A forged `move` that jumps levels without
stairs → server refuses and corrects.

**Verification.** Unit: level transitions only at stairs, edges block, forged level change
corrected, removal with a player upstairs refused, level-0 equivalence test. Two browsers: A builds
a two-storey house with stairs, walks up, sits on an upstairs chair; B sees A upstairs and seated
(server positions + y); A clicks a spot downstairs and walks down; server restart resumes A
upstairs.

**Dependencies / conflicts.** Wants #3's per-storey cutaway (hide storeys above the player's level);
build #3 first or give both to one worker. Touches `BuildLayer.tsx` fading (also #3, #5). Independent
of #1, #6, #7, #8.

**Verdicts.**
- New: "Not a first-ten-minutes thing, but seeing someone wave from an upstairs window would hook me."
- Regular: "The thing I most want. Two-storey houses I can't enter feel like a broken promise."
- Art: "Yes; the stairs must look like the town's joinery and the fade must be calm, not stippled."
- Eng: "Dissent on timing: highest-risk change on the list. Only with the flag, the level-0 equivalence test, and #3 first."
- Mod: "OK with the removal and Unstuck rules; no new text, no new trap."

---

### 3. Built interiors you can read

**Type:** update (player building / rendering)

**Pitch.** Step into a house you or someone else built and it opens like the town's buildings do:
the roof lifts away cleanly and the walls between you and the camera drop to low stubs, so the
whole room — the bed, the rug, the table lamp — is clear. Today the same view is a coarse dotted
ghost of every wall and roof over the room.

**Why now.** The owner asked for "more things to put inside", and the furniture is hard to see in
small built rooms (`docs/screenshots/build/interior-day-desktop.jpg`). It is a known weak point and
the payoff for every other building feature.

**What it touches.**
- `shared/src/building.ts`: pure `enclosureAt(index, p)` — the walls / roof / upper storeys of the
  built room containing p (floor tiles or a house roof bounded by walls), unit-tested.
- `client/src/build/BuildLayer.tsx` + `materials.ts`: per-instance cut height (`aCut`) next to the
  existing `aFade`, a height clip in the instanced wall material and the fade-aware shadow depth
  material, so camera-facing walls cut to a 0.95 m stub (same as `client/src/world/cutaway.ts`) and
  roofs fully dissolve when inside; the coarse dither stays only for "walking behind a tall wall".
- Hysteresis at the doorway like the town cutaway; per viewer (purely client side).
- No server, protocol or migration changes.

**Size / main risk.** M. Risk: shader change on instanced groups that also feed shadows; must not
add draw calls (measure with `snapshot().buildRender`).

**Abuse and mitigation.** Render-only. Interiors are already visible through the dither; nothing
new is revealed. No text, no state.

**Verification.** Unit: `enclosureAt` for a hut, an L house, a two-storey house, an open porch,
pieces of two different owners side by side. Screenshots before/after (day/night, desktop, phone
portrait + landscape, four rotations). Two browsers: A inside A's house sees stub walls and no
roof; B outside at the same moment sees the house whole; draw calls unchanged.

**Dependencies / conflicts.** Independent. #2 builds on it. Shares `BuildLayer.tsx` with #2 and #5.

**Verdicts.**
- New: "Yes — right now I can't tell what's in that cottage."
- Regular: "Yes. I furnish rooms nobody can see properly, including me."
- Art: "Strong yes. The dotted look is the least premium thing on screen."
- Eng: "Yes; small, client-only, measurable. Draw calls must not move."
- Mod: "No concerns."

---

### 4. A phone that shows the world

**Type:** update (mobile UI)

**Pitch.** On a phone, building and the building activities leave the world visible. In landscape
the build dock collapses to a slim strip — the chosen piece, Rotate, Undo, Place, Done — and the
palette slides up only when you tap the piece chip. Activity sheets (piano, notice board, guest
book, poll) open at a "peek" height with a drag handle, and the camera eases so you and the thing
you are using sit in the visible part of the screen.

**Why now.** The owner requires desktop and phone. Known weak points: "phone-landscape build dock
covers much of the screen" (`build/palette-phone-landscape.jpg`, roughly the lower 45%) and
"activity bottom sheets cover the room on phones" (`activities/cafe-night-phone.jpg`, the piano
sheet over the lower half of the café).

**What it touches.**
- `client/src/build/BuildUi.tsx`, `build.css` (collapsed dock state, piece chip, landscape rail).
- `client/src/ui/primitives.tsx` (`Sheet` gains a `peek` mode with a drag handle),
  `client/src/activities/Panels.tsx`, `activities.css`.
- `client/src/player/CameraRig.tsx`: a screen-space view offset while a sheet or dock occupies
  part of the screen (camera centre moves to the free area; no change to world state).
- No server, protocol or migration changes.

**Size / main risk.** S-M. Risk: touch hit-test regressions around the joystick and the camera
buttons (the README already notes a toast overlapping them on narrow phones).

**Measure before/after.** Share of the viewport covered by UI at 390x844 and 844x390 with the dock
open and with the piano open (target: collapsed landscape dock ≤ 20%, piano peek ≤ 40% in
portrait); player and station both inside the uncovered area (checked from `snapshot()` screen
positions).

**Abuse and mitigation.** None new (UI only).

**Verification.** Unit (`client/test/ui-logic.test.ts`): dock state machine, sheet heights.
Extend the `e2e:combined` phone layout hit tests to the new states. Two browsers: phone builds a
hut entirely with the collapsed dock while desktop watches; phone plays the piano in peek and the
desktop hears it; screenshots for both orientations.

**Dependencies / conflicts.** Independent. Touches `BuildUi.tsx` with #1, #6, #7 (different
sections).

**Verdicts.**
- New: "Yes — on my phone I couldn't see what I was building."
- Regular: "Yes, I build on my phone on the sofa."
- Art: "Yes; less chrome is always better. Keep the handle and strip quiet."
- Eng: "Small, low-risk, measurable. Good first pick for a worker."
- Mod: "No concerns; keep Report reachable from the collapsed dock."

---

### 5. Frame budget and adaptive quality

**Type:** performance

**What gets measurably better.** Smoother frames on weaker devices, and for the first time a way to
know the real frame rate. Today: ~130-142 draw calls / 0.80-0.84 M triangles at the default view
(medium, midday), up to 1.2 M in the Town Square and 1.16 M with 2,000 built pieces, and frame
rate measured only in software rendering.

**Pitch (indirect).** Settings gets a small "Performance" section: frames per second, frame time
(median and slow frames), draw calls and triangles — numbers a tester or the owner can read on a
real phone. If frames stay slow for ~10 s, the game quietly steps graphics down one level (and
says so once); you can lock your choice. Behind the scenes the heaviest meshes get cheaper: the
4x6 m gable house roof (3,232 triangles) gets a lighter build at distance, trees and small props
drop detail far from the camera, and tiny props stop casting shadows at low sun.

**What it touches.**
- `client/src/game/perf.ts` (frame-time ring buffer, p50/p95), `client/src/world/env.ts` (`QUALITY`
  step-down with hysteresis; never steps up past the user's choice), `client/src/ui/panels/SettingsPanel.tsx`.
- Triangle trims: `client/src/build/meshes2.ts` (roof LOD), `client/src/world/Nature.tsx` (tree LOD),
  shadow casting flags in world props.
- `scripts/perf-baseline.mjs` (new, headless): records calls/triangles at fixed `?time=0.5` views
  (default spawn, `?cam=town_square`, `?cam=cafe&inside=cafe`, 2,000-piece world via
  `build-scale.mts`) into `docs/perf/baseline.json`, and fails if a later run is > 10% worse.
- Nothing leaves the browser: no telemetry, no external service.

**Measure before/after.** The baseline script at the three views and the 2,000-piece world;
targets: −20% triangles at the default and Town Square views on medium, build layer ≤ 0.5 M
triangles for the 2,000-piece mix, draw calls not up. Frame time on real devices is reported by the
new readout (the owner or testers read it; see "needs the owner").

**Size / main risk.** M. Risk: visible popping from LOD; adaptive quality oscillating. Mitigation:
LOD switch distances beyond the iso camera's usual framing, step-down only (no automatic
step-up within a session).

**Abuse and mitigation.** None (local only).

**Verification.** Unit: step-down hysteresis logic, ring-buffer percentiles. Baseline script
before/after committed. Two browsers: both at medium; force slow frames in one (dev flag) and see
it step down to low while the other stays medium and both still see each other move and build.

**Dependencies / conflicts.** Independent; touches `meshes2.ts` (also #7 roofs) and `BuildLayer.tsx`
(#2, #3) lightly. Should land before rain/snow (parked) is reconsidered.

**Verdicts.**
- New: "Invisible to me unless my phone stutters — then it's everything."
- Regular: "Fine; my 2,000-piece street shouldn't make the town crawl."
- Art: "Accept, if LOD never shows on screen at the default zoom and quality steps are announced gently."
- Eng: "Must-have. We have never measured a real GPU; this gives us the meter and a regression gate."
- Mod: "No concerns; confirm nothing is sent off the device."

---

### 6. The Workshop makes new pieces

**Type:** new feature (progression without money)

**Pitch.** At the Workshop the town works together on projects that add new things to everyone's
build palette: "A kiln for glazed tiles" (two glazed roof colours), "Brick moulds" (brick walls and
a brick chimney), "A glazier's bench" (bay window, window boxes), "A turner's lathe" (spindle
fence, banister). Locked pieces show in the palette, softly greyed: "The town can make this at the
Workshop — stage 1 of 3". When the last stage is done, everyone on the island gets the pieces at
once and the Gazette says who made it happen.

**Why now.** The owner asked for "more things to put inside" and "continuous improvement". Today
the Workshop runs out after three projects and Bram says "Every project on the list is done. More
are coming." — a dead end in a building the owner asked to have "things going on". It also answers
"progression without a pay economy": the town progresses, together, by real players' work.

**What it touches.**
- `shared/src/activities.ts`: `PROJECTS` gains entries with `unlocks: { kinds?: PieceKind[];
  variants?: string[] }`; the existing three keep their outdoor outcomes.
- `shared/src/building.ts`: `PieceDef.unlockedBy?: projectId`; `validatePlacement` ctx gets the
  unlocked set; existing pieces are never gated (only new pieces/styles are).
- `server/src/activities/` project completion → building service updates the unlocked set
  (already persisted as project state in world kv; no new table needed).
- Protocol: unlocked set in the first build snapshot chunk + an `S2C.buildUnlocked` delta.
- Client: `BuildUi.tsx` locked tiles + hint; `meshes2.ts` for the new pieces; `activities/Indoor.tsx`
  project models on the sawhorses; Gazette template `pieces_unlocked`.

**Size / main risk.** M. Risk: the new pieces' art must match the miniature look and triangle
budget (#5). Second risk: fresh worlds start with fewer new pieces — acceptable because nothing
existing is gated.

**Abuse and mitigation.** One person with several guest profiles could push projects alone →
existing distinct-player thresholds (`WORKSHOP_STAGE_DISTINCT`) plus counting only profiles that
have been on the island for a while (e.g. joined at least a world-day earlier or played ≥ 10 min);
per-day limit already exists. A forged placement of a locked piece → server refuses (`locked`
reason with a visible text).

**Verification.** Unit: locked piece refused / unlocked accepted (shared), forged locked placement
refused (server), completion unlocks across room instances. Two browsers with lowered
`WORKSHOP_STAGE_*` env: both work the project, the piece appears in both palettes, B places it, A
sees it; restart; still unlocked; a late joiner gets it in the snapshot.

**Dependencies / conflicts.** Independent. Migration not needed unless the worker chooses a table
(then coordinate numbering with #1). Touches `BuildUi.tsx`, `meshes2.ts`.

**Verdicts.**
- New: "Nice — the greyed pieces tell me there's somewhere to go and something to do."
- Regular: "Yes. Progress I share with the town, not a shop."
- Art: "Yes, if every new piece is held to the same craft bar; four great pieces beat twelve okay ones."
- Eng: "Good: rules as data, server-checked, reuses project persistence."
- Mod: "Yes with the account-age rule against guest-profile farming."

---

### 7. One roof for L, T and U houses

**Type:** update (player building)

**Pitch.** Point the roof tool at an L-shaped (or T- or U-shaped) house and the ghost becomes one
roof: ridges meet, valleys fold in properly, and the eaves run round the inside corner. Hip roofs
get the same scalloped tile courses, ridge caps and eaves as the gable ones, so they no longer look
plainer than the town's.

**Why now.** The owner's first building feedback was "proper sloped roofs". Known weak points:
"L-shaped roofs overlap instead of joining, roof tool handles rectangles only; hip roofs plain"
(`build/house-L-day-desktop.jpg` shows two roofs crossing).

**What it touches.**
- `shared/src/building.ts`: `RoofParams` gains an optional rectilinear `outline` (≤ 12 corners,
  0.5 m grid, compact string; old rectangle params unchanged and still valid);
  `detectRoofSpan` → `detectRoofOutline`; `roofEdgesSupported` per outline edge; validation caps
  (vertex count, max span, param length) so nothing oversized reaches the server.
- `client/src/build/meshes2.ts`: roof generator for rectilinear outlines (straight skeleton for
  orthogonal equal-pitch outlines: hips, valleys and ridges), tile courses on every facet; hip
  rectangle gets the same treatment.
- `client/src/build/actions.ts` (roof tool detection), `BuildUi.tsx` (roof options),
  instancing key in `BuildLayer.tsx` (params-keyed groups already exist).
- No migration: params are already a stored JSON string (`build_pieces.params`).

**Size / main risk.** M-L. Risk: geometry edge cases (U shapes, narrow wings) and triangle cost;
mitigated by restricting to rectilinear outlines, a vertex cap, a triangle budget test, and falling
back to "two roofs" when the outline is not supported.

**Abuse and mitigation.** Giant or degenerate roofs → server-side param validation (caps above,
must rest on the builder's own walls along most of the outline). No text.

**Verification.** Unit: skeleton output for L/T/U/rectangle (watertight, facet count, heights at
corners), param parse fuzzing, support rules. Screenshots of the L house before/after at four
rotations, day and night. Two browsers: A builds an L house and one roof; B sees the same roof;
restart; old rectangle roofs in an existing world still load and render unchanged.

**Dependencies / conflicts.** Independent. Touches `meshes2.ts` with #5 (roof LOD) — agree on one
roof generator; whoever is second rebases.

**Verdicts.**
- New: "I'd never notice, until I tried to build an L-shaped house."
- Regular: "Yes, the crossing roofs look like a mistake on my best house."
- Art: "Yes — the roofs are the silhouette of the town; this matters more than it sounds."
- Eng: "Dissent on size: geometry is the tricky part. Rectilinear only, with a fallback."
- Mod: "Fine with the server caps."

---

### 8. One harness for the browser suites

**Type:** maintenance

**What gets measurably better.** Every future change is checked faster and more reliably. Today
there are six browser e2e suites (`scripts/e2e-*.mjs`, ~4,700 lines; `scripts/lib/browser.mjs`
already shares some code), each spawning its own production server and two browsers, using
time-based waits because software rendering draws 1-3 frames per second; README notes they "time
out with several browser suites competing for the CPU". There is also an unexplained phone
tap-to-move stall when walking to the Town Hall with no repro.

**Pitch (indirect).** Workers and QA get `npm run e2e:all`: one command that runs the suites in
sequence with a summary table (check name, pass/fail, time), `--only <suite|check>` to rerun one
thing, and waits that poll the game's own debug snapshot (`window.__ELSEWHERE__.snapshot()`) for
the condition instead of sleeping. A new phone check walks by tap-to-move from each spawn to every
public door, logging path, corrections and stalls, to pin down the Town Hall stall.

**What it touches.** `scripts/lib/` (server spawn with fresh data dir, two-browser setup, named
checks, `waitForSnapshot(predicate)`, screenshot helper), each `scripts/e2e-*.mjs` ported one at a
time with the same named checks, `package.json` scripts, README "Testing". No product code (unless
the stall repro finds a bug — then a separate fix).

**Measure before/after.** Total wall-clock of all suites run in sequence on the same machine;
failures across three consecutive full runs (target: zero); lines of duplicated harness code; the
check-name list per suite must be identical before and after (diffed).

**Size / main risk.** M. Risk: porting tests can silently weaken them. Mitigation: port one suite
per commit, diff the check names, and keep each check's assertions unchanged.

**Abuse and mitigation.** None (test tooling). The harness must keep using fresh temp data dirs and
never read real secrets.

**Verification.** Run `e2e:all` three times green on a quiet machine; record times before/after in
the PR; the tap-to-move check runs on the emulated phone against all doors.

**Dependencies / conflicts.** Scripts only, so it builds in parallel with everything, but other
workers will add checks to the same suites: they should write new checks with the new
`waitForSnapshot` helper as soon as it lands, and the harness worker ports suites not being edited
first (acceptance, interiors, player) and the build suites last.

**Verdicts.**
- New: "Nothing I'll see, except fewer broken days."
- Regular: "If it stops my house from breaking after updates, yes."
- Art: "Neutral; keep the screenshot outputs, they are how I review."
- Eng: "Yes — the slowest part of every cycle; and the stall needs a repro."
- Mod: "Yes; a repro for the phone stall matters to players who report being stuck."

---

## Parked (best ideas that did not make the cut)

| Idea | Type | Why parked |
|---|---|---|
| Garden plots (plant the store's seed packets; neighbours water them over real days) | new feature | Strong "together" idea; lost narrowly to Workshop unlocks. First in line next cycle. |
| Shared rain and snow (server-clock weather, rain on roofs, people under awnings) | update | Wait for #5 so particles have a frame meter and a step-down; Art dissents. |
| Keepers step out at closing and walk home; labelled lines between keepers | update | Lovely life; needs care so it never reads as players; after the frame budget. |
| World-wide online count across room instances | update | Honest and small; better done as a chore than a cycle slot (instances already share one process via `roomRegistry`). |
| Phone tap-to-move stall to the Town Hall (fix) | maintenance | Needs a repro first — #8 adds one; fix follows as a bug ticket. |
| Hand a curiosity to another player (gifts), curiosities into the hand | new feature | Good social tool; needs an accept/decline flow against unwanted gifts. |
| Event listings with a time and "I'll come" on the notice board | new feature | Social, but needs notification design and anti-spam; after homes. |
| Move tool and repaint a placed piece | update | Quality of life; smaller than the chosen items, good filler for a worker with spare time. |
| Blueprints (save and rebuild/share a house) | new feature | Big; grief risk (mass placement) and art risk; later. |
| Display curiosities on built shelves | new feature | Natural follow-up to "Your home". |
| First-day postcard checklist | new feature | Risk of a quest-log feel; revisit when there is first-session data from QA. |
| Opt-in friends and "where is my friend" | new feature | Privacy design needed; after homes. |
| Transparent window glass from outside | update | Small art fix; bundle with the next rendering pass. |
| Fishing off the dock, music jam with the tin whistle | new feature | Fun but solo-leaning or noisy; lower priority than building depth. |
| Client bundle size / code splitting | performance | Not a measured problem yet; add to #5's baseline script first. |
| Run the test suite against real Postgres | maintenance | Needs a Postgres instance in CI — see "needs the owner". |
| Migrate legacy roof tiles to house roofs | maintenance | Low value until #7 lands. |

## Needs the owner

1. **Houses 3-5 ("a future home").** Make them claimable homes (scarce: three for everyone), turn them
   into public houses with activities, or keep them closed? Proposal #1 gives everyone a home without
   deciding this.
2. **Money and a currency.** The README lists "a gentle currency earned by being around" and buying
   pieces as future features. The committee recommends progression without currency for now
   (proposal #6); adding a currency is a change of direction only the owner can make.
3. **Co-building.** Letting a friend build on your house changes the current rule that upper pieces
   rest only on your own pieces (which today prevents pinning someone else's house). Owner's call.
4. **Doors that close and lock / private homes.** Changes who can enter what and creates trap
   risks; also changes the "doors never block" behaviour the interiors were built on.
5. **Real-device measurement.** Frame rate has only been measured in software rendering. Proposal #5
   adds an in-game readout, but someone with real phones/GPUs (and Safari) has to run it and report.
6. **Real Postgres / Supabase verification.** Needs a database instance (new infrastructure); the
   brief forbids adding external infrastructure without the owner.
