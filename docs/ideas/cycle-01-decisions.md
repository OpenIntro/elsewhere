# Cycle 01 — Vetting decisions

Date: 2026-11-27. Input: `cycle-01-proposals.md` (8 ranked proposals). Every claim below was
checked against the code at commit `444d503`, not taken from the proposals file. Where the
committee was wrong, it says so.

## Verdicts

| # | Proposal | Type | Verdict | One line |
|---|---|---|---|---|
| 1 | Your house, your home | new feature | **deferred** (first in line next cycle, reshaped) | Several "reuse existing code" premises are false; it is L, not M, and needs product decisions first. |
| 2 | Stairs and walkable upper floors | update | **deferred** | Highest-risk change on the list; shared collision has no notion of level. Needs #3 landed and a frame meter first. |
| 3 | Built interiors you can read | update | **approved with changes** → Brief A | True weak point, client-only, measurable, owner's "more things inside" pays off only if you can see inside. |
| 4 | A phone that shows the world | update | **approved with changes** → Brief B | Coverage is worse than the committee said; landscape-only dock cut keeps the touch-build e2e stable. |
| 5 | Frame budget and adaptive quality | performance | **deferred** (reshaped) | Distance LOD is meaningless under the orthographic camera; the real triangle lever is elsewhere. Needs a rewrite before building. |
| 6 | The Workshop makes new pieces | new feature | **deferred** | Sound idea, but new piece art + gating + an anti-farming rule that changes today's Workshop behaviour; not this cycle. |
| 7 | One roof for L, T and U houses | update | **deferred** (staged) | Real geometry project (L, not M-L). Stage the cheap half (hip roof tile courses) next cycle. |
| 8 | One harness for the browser suites | maintenance | **approved with changes** → Brief C | Real cost, but half the "missing" helpers exist; reshaped to a runner + shared server helper + door-walk audit, no assertion rewrites. |

The approved set is a deliberate mix: two updates to existing features (one building/rendering,
one phone UI) and one maintenance item. No new feature was approved this cycle: both new-feature
candidates (#1, #6) turned out bigger than stated and #1 needs product decisions recorded first
(see "For the committee to decide next cycle"). No approved item adds a migration, protocol
message, synced field or server code.

## Evidence and reasoning per proposal

### 1. Your house, your home — deferred

Checked: `server/src/activities/index.ts`, `server/src/interactions/index.ts`,
`shared/src/world/interactables.ts`, `client/src/ui/panels/SimplePanels.tsx`,
`server/src/building/index.ts`.

- **"Guest book … owner removal already exists" — wrong.** `removeEntry`
  (`server/src/activities/index.ts` ~l.505) lets only the *author* take an entry down
  ("Only the person who wrote it can take it down"). The House 1/2 books have no owner. A home
  owner removing entries from their own book is new server logic and a new moderation rule.
- **"Blocked players cannot … send you mail (existing block relation)" — wrong.** Mail send
  (`interactions/index.ts` `mailSend`, ~l.438) does not check blocks; blocks are only applied
  when *reading* (`sendMailList` filters `isBlockedBetween` / `isMutedBy` for the reader).
- **"Receives the same letters the town mailboxes do" — misleading.** Mailboxes are public note
  boxes keyed by `mailboxId` (anyone at the box reads the last 20 notes), not personal inboxes.
  A home mailbox is either a public note box at the house or a new private-inbox concept.
- **"Reuse the guest-book logic with board id `home:<profileId>`" hides a sync problem.** Boards
  are published through `syncBoard` → `putAll(ACTIVITY_KEYS.board(id))`, i.e. entries in the
  Colyseus `state.activities` map. Per-home boards would put one synced entry per home into the
  room state — exactly what the proposal says to avoid ("keep homes out of the schema").
  Stations are also static data (`STATIONS`), so a book on a built house needs a resolver like
  built seats.
- What is true: `structure_roofed` / `building_named` detection exists
  (`server/src/building/index.ts` l.334/346), `registerInteractableResolver` exists, the Home panel
  says "Not yet" / "Planned" (`SimplePanels.tsx` l.84/97). Next free migration is **#6**
  (`migrations.ts` has 1-5).
- Realistic size: L (new table, protocol, resolver, mailbox semantics, owner moderation, block
  enforcement on write, map pins + privacy, clear-on-removal, client in four places). It also
  touches `BuildUi.tsx` / `BuildLayer.tsx`, which Briefs A and B own this cycle.
- Reshape for next cycle: start with "Make this my home" + map pin (opt-in) + "Ivy's home · 2
  inside" on approach, migration #6; guest book with owner removal and send-side block checks as
  stage 2; mailbox semantics decided by the committee first.

### 2. Stairs and walkable upper floors — deferred

Checked: `shared/src/collision.ts` (326 lines, no level parameter anywhere),
`shared/src/building.ts` (`walkSurfaceAt` l.1311, `pieceColliders` l.556: only level-0 solids
collide), `server/src/rooms/WorldRoom.ts` `handleMove` (l.386).

- Current behaviour is as described (README limitation: upper storeys visual only).
- Size L is honest, possibly understated: shared collision, server move validation, the client
  NavGrid, remote character y, reconnect resume, seat reachability and removal rules all change.
  It touches the movement path every player uses every tick.
- It depends on #3 (per-storey cutaway) — which is being built now — and should be measured with
  a frame meter (#5). Building both #2 and #3 in one cycle by one worker would sprawl.
- Keep the committee's mitigations (flag `BUILD_UPSTAIRS`, level-0 byte-identical path,
  property test of random level-0 moves before/after, Unstuck always works) as hard requirements
  when it comes back.

### 3. Built interiors you can read — approved with changes (Brief A)

Checked: `client/src/build/BuildLayer.tsx` (`fades`/`screens` l.71-78, `updateFade` l.421-475),
`client/src/build/materials.ts`, `client/src/world/cutawayRuntime.ts`, `Cutaway.tsx`,
`docs/screenshots/build/interior-day-desktop.jpg`, `shared/src/building.ts`
(`detectRoofSpan` l.1509, `roofEdgesSupported` l.1040).

- Behaviour confirmed: inside a built house the roof is dissolved (`target = 1` when a roof or
  upper floor covers the player), but camera-side walls only go to a 0.8 dither within 2.6 m
  and everything uses the same coarse 4x4 screen-door pattern; the screenshot shows the room
  behind a dotted veil.
- **Committee file reference wrong:** `client/src/world/cutaway.ts` does not exist; the town
  cutaway is `cutawayRuntime.ts` + `Cutaway.tsx`, and its 0.95 m stubs are *untagged geometry*
  (the stub is built separately), not a height clip. For instanced pieces a height clip in the
  shader is the right equivalent (the template is one mesh), so the approach is sound, but it is
  new shader work, not a copy.
- Missing from the proposal: wall mounts (pictures, shelves, curtains, name boards) on a cut
  wall must hide with it or they float; window glass is a separate material bucket and needs
  the same clip; build picking (`picking.ts`) must look through cut parts like it already looks
  through dissolved ones.
- No server, protocol or migration change; adding an instanced attribute does not add draw
  calls. Size M is credible.

### 4. A phone that shows the world — approved with changes (Brief B)

Checked: `client/src/build/build.css` (landscape media query l.245), `BuildUi.tsx`,
`client/src/ui/primitives.tsx` (`Sheet`, already has a touch drag-to-close), `activities/Panels.tsx`
(piano sheet `size="wide"`), `client/src/player/input.ts` (`screenToWorld` l.213),
`client/src/build/picking.ts` / `client/src/player/picking.ts`, screenshots.

- **Committee numbers understated.** The screenshot it cites (`palette-phone-landscape.jpg`) is
  the round-1 dock (four tabs). The current round-2 dock
  (`palette-living-phone-landscape.jpg`) covers about **52%** of the landscape viewport height
  (and two thirds of its width). The piano sheet covers about **57%** of the portrait height in
  `activities/cafe-night-phone.jpg` (and the keeper tag is cut off at the right).
- **Risk the committee missed:** a projection view offset in `CameraRig.tsx` would desync
  ground picking, because `screenToWorld` (player input) uses its own camera math
  (`screenToWorldDir` with `cameraRuntime.yaw`) while build picking uses a three.js
  `Raycaster`. The camera ease must go through one mechanism both honour (a focus shift in
  `cameraRuntime`, not `setViewOffset`), with a tap-accuracy check.
- `Sheet` is used by every panel; a peek mode must be opt-in per panel.
- `e2e:build2` builds by touch on a **portrait** Pixel 7 and `e2e:combined` check 7 hit-tests
  the dock at 390x844 and 844x390. Restricting the collapsed dock to landscape keeps build2's
  touch flow unchanged and makes check 7 the regression gate.

### 5. Frame budget and adaptive quality — deferred (needs a rewrite)

Checked: `client/src/game/perf.ts` (CPU section timers only), `client/src/world/env.ts`
(`QUALITY`), `client/src/world/World.tsx` (`__ELSEWHERE_WORLD__.info()` with `avgFrameMs`,
**dev builds only**, l.98), `client/src/player/CameraRig.tsx` (orthographic),
`client/src/build/BuildLayer.tsx` l.312.

- **"Lighter build at distance" is not a real lever here.** The camera is orthographic: every
  object on screen is drawn at the same scale regardless of distance, so distance LOD either
  pops visibly or saves nothing. Rejected as a technique.
- **The real lever the proposal missed:** each build instancing group computes one bounding
  sphere over all its instances (`mesh.computeBoundingSphere()`), so a group of roofs spread over
  the island is never frustum-culled — 2,000 pieces cost 0.70 M triangles wherever you look.
  Spatially chunked groups (the town's `Architecture.tsx` is already chunked) are the
  candidate, traded against draw calls.
- The baseline script cannot use `__ELSEWHERE_WORLD__.info()` on a production build; it would need
  the dev client or a production-safe read-only counter (`snapshot().buildRender` is available
  in production, the whole-frame numbers are not).
- Adaptive step-down recompiles shaders on change (env owns `gl.shadowMap.enabled`) — a hitch on
  exactly the weak device it is trying to help; needs care.
- It also touches `BuildLayer.tsx` (owned by Brief A this cycle). Reshape and bring back next
  cycle (see recommended order).

### 6. The Workshop makes new pieces — deferred

Checked: `shared/src/activities.ts` (`PROJECTS` l.345: three projects; "Every project on the list
is done. More are coming." l.477), `server/src/activities/index.ts` (project state in world kv,
`completed[]` l.132/593), `client/src/activities/Panels.tsx` l.532.

- Behaviour confirmed: the Workshop dead-ends after three projects.
- Cost understated: every new piece needs template art at the round-2 craft bar plus triangle
  budget (README triangle table), gating in `validatePlacement`, a snapshot field, a delta, and
  palette changes in `BuildUi.tsx` (owned by Brief B this cycle) and `meshes2.ts`.
- The anti-farming rule ("joined at least a world-day earlier or played ≥ 10 min") changes how
  today's Workshop counts contributions and would break `e2e:activities`, which finishes a
  project with two fresh guests under lowered thresholds. It needs an env override designed in.
- Cheap interim fix worth doing as a chore: more outdoor-outcome projects as data (no new pieces),
  so the Workshop stops dead-ending.

### 7. One roof for L, T and U houses — deferred (staged)

Checked: `client/src/build/meshes2.ts` (`houseRoof` l.47 builds gables with the town kit's
`roof(...)` and hips with `pavilionRoof(...)`), `shared/src/building.ts` (`parseRoofParams`
l.449, `detectRoofSpan` l.1509).

- Behaviour confirmed: rectangles only; hip roofs use the plain `pavilionRoof`.
- The town kit has no valley or straight-skeleton generator; an orthogonal skeleton with tile
  courses on every facet, plus outline detection, support rules per edge and param caps, is L.
- Staged for next cycle: **stage 1 (S)**: hip roofs get the gable's scalloped courses, ridge caps
  and eaves (meshes only, same params). **Stage 2 (M-L)**: L outlines only (one valley pair),
  with fallback to two roofs; T/U later.

### 8. One harness for the browser suites — approved with changes (Brief C)

Checked: `scripts/lib/browser.mjs`, `scripts/e2e-*.mjs`, `package.json`.

- **Partly wrong:** a poll-the-snapshot wait already exists (`waitSnap` in `lib/browser.mjs`,
  used 143 times across the suites); there are only ~110 raw sleeps in all eight suites.
  Rewriting waits is not where the time goes.
- **Real duplication:** six suites each carry their own `startServer` (spawn
  `server/dist/index.js`, temp data dir, readiness, restart); only three of six production-server
  suites (build, build2, combined) import `lib/browser.mjs`.
- **Real bug the committee missed:** `e2e:build` and `e2e:build2` both default to port **2634**
  (`BUILD_PORT ?? 2634`, `BUILD2_PORT ?? 2634`), so they cannot run side by side and a leftover
  server from one breaks the other.
- **"Phone tap-to-move stall to the Town Hall"**: not recorded anywhere in the repository (README,
  ARCHITECTURE, commit messages). Treated as an unverified report; Brief C builds a diagnostic
  walk that either reproduces it or records that it did not.
- Cut: "`--only <check>`" — the suites are sequential stories (restart checks depend on earlier
  state), so re-running a single check is unsound. Cut: porting each suite onto a new check
  framework (risk of silently weakened assertions for little gain).

## Build briefs

Three workers build in parallel. File ownership is exclusive; anything not listed is read-only
for all three. Nobody adds a migration (next free number stays **#6**, reserved for "Your home"
next cycle). Nobody changes `shared/src/protocol.ts`, `server/**`, `server/src/rooms/schema.ts`,
`client/src/build/meshes2.ts`, `meshes.ts`, `actions.ts` or `shared/src/building.ts`.

### Shared-file rules (all three)

| File | Rule |
|---|---|
| `client/src/build/BuildLayer.tsx`, `materials.ts`, `picking.ts` | **A only.** |
| `client/src/build/BuildUi.tsx`, `build.css`, `store.ts` | **B only.** (A needs no UI.) |
| `client/src/player/CameraRig.tsx`, `client/src/ui/primitives.tsx`, `client/src/activities/Panels.tsx`, `activities.css` | **B only.** |
| `scripts/lib/browser.mjs` | C owns; A and B may *add* new exported helpers at the end of the file only, no edits to existing ones. |
| Existing `scripts/e2e-*.mjs`, `smoke-two-clients.mjs`, `server-integration.mjs` | **C only, harness boilerplate only** (server spawn/stop/restart, result output); no check body, assertion, timeout or check name changes. A and B do not edit them. |
| New e2e scripts | A: `scripts/e2e-built-interiors.mjs` (default port `BINT_PORT` 2641). B: `scripts/e2e-phone.mjs` (`PHONE_PORT` 2642). C: `scripts/e2e-doors.mjs` (`DOORS_PORT` 2643). |
| `package.json` `scripts` | C owns. A and B each add exactly one line (`e2e:built-interiors`, `e2e:phone`); C resolves the merge. |
| `scripts/e2e-all.mjs` suite list | C owns; A and B's suites are added to the list as part of the merge (one array entry each). |
| `scripts/build-screenshots2.mjs` | A only (interior views). |
| `README.md` / `docs/ARCHITECTURE.md` | Each edits only its own paragraphs: A the "Rendering" bullet of Player building, the Client build paragraph and the relevant limitation; B the Controls rows for touch build / sheets and the narrow-phone limitation; C the Testing table and the "Headless browser tests" limitation. One new Testing row each for A and B. |
| `client/test/*`, `shared/test/*` | New files only (`shared/test/buildEnclosure.test.ts`, `client/test/builtCutaway.test.ts` for A; `client/test/phoneLayout.test.ts` for B). Do not edit existing test files. |

Merge order: **C first** (scripts only), then **A**, then **B** (B touches the most widely used UI
primitive and goes last so its regression run covers A's changes). Each worker rebases before
merge and re-runs its own suite plus the listed existing suites on the rebased tree.

Common rules for every brief: real multiplayer only; no new external services; no AI or model
names in code or docs; procedural assets only; desktop and phone; zero console errors in every
browser run; "pass twice in a row" means two consecutive full runs of the named script on a
quiet machine (no other browser suite running), both green.

---

### Brief A — Built interiors you can read

**Goal.** When the local player is inside a house built from pieces, it opens like the town's
buildings: the roof and anything above the player's storey is gone, the walls facing the camera
drop to low stubs, and the room's furniture is fully visible — no dotted veil over the room.

**Design constraints.**
- Purely client-side and per viewer. No server, protocol, schema or migration change.
- No extra draw calls: implement as per-instance attribute(s) next to `aFade` (e.g. `aCut`, a
  world-space clip height; "no clip" = large value) on the existing instanced groups, honoured
  by `pieceMaterial`, `pieceGlassMaterial` and `pieceDepthMaterial` (cut parts cast no shadow,
  like a faded roof today).
- Stub height 0.95 m above the piece's base (matches the town cutaway's stubs). The clip edge
  should read clean (a hard cut, optionally a thin darker cap line in the shader), not dithered.
- Look of everything outside the active enclosure is unchanged; the existing dither stays for
  "walking behind a tall wall" outdoors.
- Hysteresis at the doorway (enter when ≥ 0.3 m inside the enclosure, leave when ≥ 0.6 m
  outside) and an eased transition (~0.35 s like the town).
- Wall mounts on a cut wall (pictures, shelves, clock, mirror, curtains, name boards) hide above
  the stub with it; table-top pieces and floor furniture are never cut.
- Build picking looks through cut parts (aiming at the floor or furniture behind a cut wall
  works), as it already does through dissolved pieces.

**Scope in.**
1. Pure `enclosureAt(index, p)` in a **new** file `shared/src/buildEnclosure.ts` (exported from
   the shared index): returns the axis-aligned room containing `p` or null. A room is (a) the
   union of footprints of `house_roof` / legacy roof / level-1 floor pieces covering `p`, or
   (b) a walled rectangle found by the existing `detectRoofSpan` logic (≥ 3 sides at least 70%
   walled) containing `p` with no roof. Result: rect, the wall-type pieces on its boundary
   (±0.5 m), the pieces above `p`'s storey inside it, and the storey. Size cap 12 x 12 m (the
   roof maximum); geometric only (pieces of any owner), since it is render-only.
2. Pure selection of camera-facing boundary walls for a camera yaw (any of the four rotations
   and in between), in the same file or `client/src/build/builtCutaway.ts`.
3. `BuildLayer.tsx` uses 1+2 for the local player each fade tick: roof/upper pieces of the
   enclosure fade fully (existing path), camera-facing walls + their mounts get the cut, far
   walls stay whole.
4. A read-only debug section `snapshot().build.cutaway` = `{ active, rect, storey, cutIds[],
   hiddenIds[] }` (or a separate `builtCutaway` section) for the tests.
5. Two-storey case: on the ground floor of a two-storey house, all pieces of storey ≥ 1 inside
   the enclosure are hidden (the per-storey basis #2 will build on).

**Scope out.** Stairs / upper-floor walking; town buildings; other players' views; changing
outdoor fade behaviour; any new pieces or meshes; `meshes2.ts`; UI.

**Files owned.** `shared/src/buildEnclosure.ts` (new) + one export line in `shared/src/index.ts`,
`client/src/build/BuildLayer.tsx`, `client/src/build/materials.ts`, `client/src/build/picking.ts`,
optional new `client/src/build/builtCutaway.ts`, `scripts/e2e-built-interiors.mjs` (new),
`scripts/build-screenshots2.mjs` (interior views), new test files listed above.

**Migration.** None.

**Acceptance criteria.**
1. `shared/test/buildEnclosure.test.ts` covers: 4x4 hut with doorway + house roof; L house (two
   roofs) → one union room; roofless room walled on 3 sides → room; open porch (3 walls + roof);
   a ring of fences → null; a 14 m walled square → null (cap); two neighbouring huts of different
   owners sharing a wall → standing in one never selects the other's far walls; two-storey house
   (ground floor: storey-1 pieces listed as hidden); standing outside → null; hysteresis helper.
2. `client/test/builtCutaway.test.ts`: camera-facing wall selection for yaw 0, π/2, π, 3π/2 and
   one in-between yaw on the 4x4 hut and the L house (expected wall ids listed in the test).
3. `npm test` and `npm run typecheck` green.
4. `npm run build && npm run e2e:built-interiors` — desktop A (1440x900) and phone B (Pixel 7,
   touch), own production server on a fresh temp data dir; A builds through the real UI (the
   `lib/browser.mjs` helpers) a 4x4 hut with doorway, window wall, house roof, bed, rug, table +
   table lamp, a picture on a camera-facing wall and one on a far wall, and a 2-storey hut next
   to it. Named checks, all must pass, **twice in a row**:
   1. A walks in through the doorway (server position inside): `cutaway.active`, the
      camera-facing walls are in `cutIds`, the roof is fully faded.
   2. At the same moment B, outside, sees that house whole (no cut, no fade on its pieces).
   3. A rotates the camera four times (Q): `cutIds` follows the camera-facing faces each time.
   4. The picture on the cut wall is hidden; the far-wall picture and all furniture are visible.
   5. A stands on the threshold for 3 s: at most one active/inactive toggle (hysteresis).
   6. A walks out: within 1 s nothing is cut or faded.
   7. B walks in by tap-to-move and gets the cutaway on the phone.
   8. On the 2-storey hut's ground floor, A's `hiddenIds` contains every storey-1 piece of it.
   9. While inside, A aims and places a table lamp on the table behind a cut wall (picking
      through the cut works; B sees the lamp).
   10. `snapshot().buildRender.drawCalls` inside == outside (same pieces), and equal to the number
       before this change for the same scene (record both numbers in the PR).
   11. Zero console errors on both pages.
5. Screenshots (reviewed, committed under `docs/screenshots/build/`): interior day + night on
   desktop, phone portrait, phone landscape, and four camera rotations on desktop by day,
   replacing `interior-*.jpg`; keep one "before" copy as `interior-before-day-desktop.jpg`.
   Review bar: bed, rug, table and lamp fully readable; stubs read as walls, not as noise; no
   floating mounts; no shadow artefacts where walls were cut.
6. Still green: `e2e:build`, `e2e:build2`, `e2e:combined`, `e2e:interiors`, `e2e:acceptance`,
   `smoke`, plus `npm test` and typecheck.

---

### Brief B — A phone that shows the world

**Goal.** On a phone, building and the building activities leave the world visible: a slim build
strip in landscape and peek-height activity sheets, with the camera easing so the player and the
thing being used sit in the uncovered part of the screen.

**Design constraints.**
- UI only. No server, protocol, schema or migration change.
- Desktop layout must not change (pixel-identical dock and sheet rects at 1440x900).
- The collapsed dock applies to **landscape phones only** (`max-height: 500px` and landscape);
  portrait keeps today's dock this cycle (protects `e2e:build2`'s portrait touch flow).
- Keep every existing `data-testid` and the existing flows working; add new test ids for new
  elements. Report stays reachable from the collapsed strip (selection card / ··· menu).
- The storey control (▲ Storey N ▼) and Next must be reachable from the collapsed strip
  (stacking is an owner-requested feature).
- Camera ease: implement as a focus shift in `cameraRuntime` that both `screenToWorld`
  (`player/input.ts`) and the build `Raycaster` picking see — **not** `camera.setViewOffset`.
  It eases in/out (no jumps), never moves the player, and is off on desktop.
- `Sheet` gains an **opt-in** `peek` prop with a drag handle (peek ↔ full ↔ close); panels
  without it are unchanged. Text entry (notices, guest book, sign words) expands to full when
  the keyboard is needed.
- Quiet art direction: the strip and handle use the existing glass/paper tokens; no new chrome.
- Tap targets ≥ 44 px; the piano's white keys ≥ 44 px wide in peek.

**Scope in.**
1. Landscape collapsed build strip: chosen-piece chip (thumbnail + name; tap opens the palette
   as an overlay, choosing a piece collapses it again), Rotate, Undo, Place, Done, ··· (Remove,
   Clear, Unstuck, storey control, Next).
2. `Sheet` peek mode; used by piano, keeper, poll, curiosity table, guest book / notices (read
   view). Peek heights: piano ≤ 40% of portrait height; others ≤ 45%.
3. Camera focus shift while the landscape strip, the expanded palette or a peek sheet covers
   part of the screen.
4. Coverage measurement in the new e2e (union of rects of the dock / sheet elements over the
   viewport area and height share).

**Scope out.** Portrait dock redesign; toast placement (README limitation stays unless fixed for
free); new panels; desktop; palette content; any change to `actions.ts` aiming logic.

**Files owned.** `client/src/build/BuildUi.tsx`, `client/src/build/build.css`,
`client/src/build/store.ts`, `client/src/ui/primitives.tsx`, `client/src/activities/Panels.tsx`,
`client/src/activities/activities.css`, `client/src/player/CameraRig.tsx` (and the
`cameraRuntime` focus-offset field it reads), `client/src/styles.css` (sheet rules only),
`scripts/e2e-phone.mjs` (new), `client/test/phoneLayout.test.ts` (new).

**Migration.** None.

**Acceptance criteria.**
1. Before numbers are measured first on the unchanged build with the new script's measuring code
   and recorded in the PR: dock area/height share at 844x390 (palette open) and 390x844, piano
   sheet at 390x844 and 844x390. (Vetting estimate from screenshots: ~52% of landscape height
   for the dock, ~57% of portrait height for the piano.)
2. Targets after: collapsed landscape strip ≤ 20% of viewport area and ≤ 25% of its height;
   piano peek ≤ 40% of portrait height; portrait dock unchanged (± 2 px).
3. `client/test/phoneLayout.test.ts`: dock state machine (enter build in landscape → collapsed;
   chip → palette open; pick → collapsed; orientation change keeps the chosen piece; Done →
   closed), peek/full/close transitions, focus-shift math (a target point lands inside a given
   free rect for each of the four camera yaws).
4. `npm test`, `npm run typecheck` green.
5. `npm run build && npm run e2e:phone` — desktop A (1440x900) and phone B (Pixel 7 rotated to
   915x412 landscape, touch), own production server, fresh data dir. Named checks, all pass
   **twice in a row**:
   1. B enters build mode in landscape: the strip is collapsed and its measured coverage meets
      target 2.
   2. B builds a hut entirely through the collapsed strip by touch: floor, three walls + doorway,
      a second-storey wall via the storey control, a house roof via the roof tool, a signpost with
      text; A sees the same pieces (ids, kinds, positions from both snapshots).
   3. B taps a free ground spot with the strip open: the ghost lands within 0.5 m of the tapped
      world point; with build mode off and a peek sheet open, tap-to-move reaches within 0.6 m.
   4. B selects A's piece: Report is reachable and sends (server returns ok).
   5. Joystick, camera buttons and the strip do not overlap (`elementFromPoint` at each control's
      centre returns that control) at 915x412, 844x390 and 390x844.
   6. B (portrait 390x844) opens the piano in peek: coverage ≤ 40% height; B's character and the
      piano's projected screen positions are inside the uncovered area within 1 s.
   7. B plays three notes; A (in the café) receives them (snapshot activity sound counters).
   8. The drag handle takes the piano to full and back to peek; Esc / close closes it and the
      camera eases back.
   9. B opens the notice board in peek, starts writing: the sheet goes full; the pinned notice
      shows on A.
   10. Desktop A's dock and piano sheet rects equal the before values.
   11. Zero console errors on both pages.
6. Screenshots (reviewed, committed under `docs/screenshots/phone/`): before and after for
   landscape build (collapsed and palette open), portrait piano (peek and full), landscape
   piano; review bar: the world is the main thing on screen, controls quiet and legible.
7. Still green: `e2e:combined` (check 7 phone layouts unchanged), `e2e:build2` (portrait touch
   build), `e2e:build`, `e2e:activities` (phone piano), `e2e:acceptance`, `e2e:interiors`,
   `node scripts/e2e-player.mjs` (camera, tap-to-move, touch), `smoke`, `npm test`, typecheck.

---

### Brief C — One runner for the browser suites (+ door-walk audit)

**Goal.** One command runs every browser suite in sequence with a readable summary, the server
spawn code lives in one place, suites can't collide on ports, and a phone door-walk audit either
reproduces the reported Town Hall tap-to-move stall or records that it did not.

**Design constraints.**
- Scripts and tooling only. No product code. If the audit finds a bug, file it (backlog row +
  repro command) — the fix is a separate item.
- No check body, assertion, timeout, check name or check order changes in existing suites. The
  list of check names per suite is diffed before/after and must be identical.
- Suites always run **sequentially** (software rendering cannot take two browser suites at once).
- Fresh temp data dirs; never read real secrets or the developer's `server/data`; random
  `SESSION_SECRET` per run.

**Scope in.**
1. `scripts/lib/server.mjs`: `startServer({ port, env, dataDir? })` → `{ url, dataDir, stop(),
   restart() }` (spawns `server/dist/index.js`, waits for `/api/health`, captures logs, kills on
   exit/SIGINT). Ported into `e2e-acceptance`, `e2e-activities`, `e2e-build`, `e2e-build2`,
   `e2e-interiors`; `e2e-combined` too if its multi-server legacy-data path fits, otherwise
   leave it and say why.
2. Fix the port clash: `e2e:build2` default `BUILD2_PORT` 2634 → 2635. One table of default ports
   in README Testing.
3. Machine-readable results: with `E2E_RESULT=<file>` each suite writes
   `{ suite, ok, ms, checks: [{ name, ok, ms, detail }], consoleErrors }` (adapter around each
   suite's existing `record`/`check` function; no change to what is checked).
4. `scripts/e2e-all.mjs` + `npm run e2e:all`: checks that `npm run build` output is newer than
   sources (else tells you to build), runs the six production-server suites (+ A's and B's new
   suites once merged) one after another; flags `--only a,b`, `--repeat N`, `--with-player`
   (adds `e2e-player`), `--with-ui` (adds `e2e-ui`, needs `E2E_ADMIN_TOKEN`); prints a summary
   table (suite, checks passed/total, time) and total wall-clock; writes
   `e2e-results/summary.json` (gitignored); exit code ≠ 0 if anything failed.
5. `scripts/e2e-doors.mjs` (`npm run e2e:doors`, diagnostic): emulated Pixel 7, touch only; from
   each spawn point walk by tap-to-move (hops of on-screen taps) to the apron of every walk-in
   door (Café, General Store, Town Hall, Workshop, House 1, House 2, Boathouse); log per route:
   taps, path length, time, server corrections, and stalls (path active but < 0.2 m progress for
   5 s). Writes a table to stdout and `e2e-results/doors.json`. Exit 0 unless `--strict`.

**Scope out.** Re-running a single check; rewriting waits/sleeps inside checks; a new check
framework; CI configuration; real-Postgres runs (owner-reserved infrastructure); fixing any bug
the audit finds.

**Files owned.** `scripts/lib/server.mjs` (new), `scripts/lib/report.mjs` (new),
`scripts/e2e-all.mjs` (new), `scripts/e2e-doors.mjs` (new), harness boilerplate of the existing
`scripts/e2e-*.mjs`, `package.json` scripts, `.gitignore` (`e2e-results/`), README Testing
section, ARCHITECTURE "Running" table.

**Migration.** None.

**Acceptance criteria.**
1. Before numbers (recorded in the PR and README): wall-clock of the six production-server suites
   run one after another by hand on the same quiet machine; lines of server-spawn code duplicated
   across suites (count of `startServer` implementations and their lines).
2. Check-name lists for each suite, before and after, diffed: identical (the diff goes in the
   PR description).
3. `npm run e2e:all` green **three runs in a row** on a quiet machine; per-run wall-clock reported
   (target: not slower than the hand-run sum; one server-spawn implementation instead of six).
4. Each suite still runs standalone with its old command and env vars (`npm run e2e:build`, etc.)
   and gives the same output as before plus the optional result file.
5. `e2e:build` and `e2e:build2` can be started one after another without a port error even when
   the previous server was killed uncleanly (stale-port detection with a clear message).
6. `npm run e2e:doors` completes on a fresh server and prints the table for all 7 doors × all
   spawn points; the report states plainly whether a stall was reproduced (with the route and
   the snapshot at the stall) or not; if reproduced, a backlog row "Fix phone tap-to-move stall"
   gets the exact repro command.
7. Unit tests for the pure parts (`report.mjs` summary/merge, stall detector on a recorded
   position series) in a new `client/test/e2eHarness.test.ts` importing the `.mjs` modules, so
   `npm test` runs them without changing the vitest configuration.
8. Still green: every existing suite through `e2e:all`, `smoke`, `server-integration` (unchanged),
   `npm test`, typecheck.

## Recommended order for deferred items (next cycle)

1. **Your house, your home (reshaped, #1)** — after the committee settles the home/privacy
   questions below. Stage 1: "Make this my home", one per player, opt-in map pin, approach label,
   clear-on-removal, migration #6. Stage 2: guest book with owner removal + send-side block
   checks, and the mailbox semantics. It also unlocks "display curiosities on shelves".
2. **Frame budget (reshaped, #5)** — a production-safe frame meter readout in Settings, a
   baseline script (needs either the dev client or a production-safe counter), and spatially
   chunked build instancing groups measured against draw calls. No distance LOD. Adaptive
   step-down only after the meter has been read on real devices (owner-reserved, below).
3. **Hip roof tile courses (#7 stage 1, S)** — meshes only; good filler.
4. **Workshop unlocks (#6)** — with an env override for the anti-farming rule; meanwhile, as a
   chore, add more outdoor-outcome projects so the Workshop does not dead-end.
5. **Stairs (#2)** — only after #3 (Brief A) and the frame meter; behind `BUILD_UPSTAIRS`, with
   the level-0 equivalence property test.
6. **Joined L roofs (#7 stage 2)**.
7. **Fix the phone tap-to-move stall** — if Brief C's audit reproduces it.

Parked ideas keep their places in `backlog.md`; the world-wide online count across instances
remains a good small chore.

## Delegated product decisions

The owner delegated four decisions (houses 3-5, currency / buying pieces, co-building,
closing/locking doors and private homes) to this loop. **None of the approved briefs depends on
any of them**, so none is settled in this cycle; settling them without a proposal that needs
them would be premature. They move from "needs the owner" to the list below.

## For the committee to decide next cycle

1. **Houses 3-5.** Claimable (scarce: three for everyone — first come, or rotating?), public
   houses with an activity, or kept closed? Vetter's note: player-built homes (#1) make
   "claimable" a scarcity problem with no fair allocation rule yet; "public with an activity"
   fits "things going on in buildings".
2. **Home mailbox semantics (needed for #1).** A private inbox only the owner reads (new concept:
   addressed mail, send-side blocks) or a public note box at the house (today's mailbox
   behaviour)? And may a home owner remove guest-book entries others wrote?
3. **Map pins for homes (needed for #1).** Opt-in or opt-out by default? Vetter recommends opt-in.
4. **Currency / buying pieces.** Keep progression without currency (Workshop unlocks) or add a
   gentle earned currency? Any currency must stay earned-only (no money, no paid services).
5. **Co-building.** Whether a player can let a named friend build on their structures, and how
   that interacts with "upper pieces rest only on your own pieces" (anti-pinning) and removal.
6. **Doors that close / lock, private homes.** Must keep "no trapping": Unstuck always works,
   nobody can be locked in, doors never seal a town building (already enforced by tests).

## Needs the owner

1. **Real-device frame measurement.** Frame rate has only been measured with software rendering;
   someone with a real phone (incl. Safari/iOS) and a real GPU has to run the game and read the
   numbers once the frame meter exists (next cycle). May we ask you, or whoever you choose, to do
   that?
2. **Real Postgres / Supabase verification.** Needs a database instance (hosted infrastructure).
   Do you want us to verify the `pg` / Supabase path, and if so, which instance may we use?
