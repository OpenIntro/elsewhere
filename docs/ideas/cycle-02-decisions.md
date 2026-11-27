# Cycle 02 — Vetting decisions

Date: 2026-11-27. Input: `cycle-02-proposals.md` (six delegated decisions D1-D6, nine proposals).
Read-only pass on the code at commit `79d4ad1` (cycle 1 QA was running; nothing was built, tested
or launched). Every claim below was checked against the files named; where the committee was wrong
or missed something, it says so.

## Verdicts

| # | Proposal | Type | Size | Verdict |
|---|---|---|---|---|
| 1 | Make this my home | new feature | M | **approved with changes** → Brief H |
| 2 | Frame meter and chunked build instancing | performance | M | **approved with changes** → Brief P |
| 3 | Tap-to-move takes the gaps you can walk | maintenance | S | **approved with changes** → Brief N (**skip if cycle 1 QA already fixed it**) |
| 4 | Hip roofs with real tile courses | update | S | **approved with changes** → Brief R (the 4th slot: size S, shares no file with H, P or N) |
| 5 | Letters and the Post House | new feature | L | **deferred** (cycle 03, first) |
| 6 | Your home's guest book | update | S-M | **deferred** (cycle 03, with letters) |
| 7 | Help build my home (helpers) | new feature | M | **deferred** (cycle 03/04; D5 amended below) |
| 8 | The Workshop never runs dry | update | S-M | **deferred**, stage 1 split out (cycle 03) |
| 9 | Doors that close, and a latch | update | M | **deferred** (after #7; D6 amended below) |

The set is one new feature, one performance item, one maintenance item and one update. It writes
**one** migration (#6, homes). No two briefs own the same file (see "File ownership").

## Rulings on the six delegated decisions

These are final unless one hits a hard limit; none does as amended.

| | Committee decision | Ruling | Reason |
|---|---|---|---|
| D1 | Houses 3-5: public houses, opened one at a time, never claimable | **Confirmed.** | Three houses cannot be shared fairly among every player who will join; a home now comes from building one (no scarcity). "Public with an activity" fits the owner's "things going on in the buildings". Nothing the owner asked for is removed. The "Not yet" home copy changes only when #1 ships. House 3 stays closed this cycle (the Post House is deferred). |
| D2 | Home mailbox = a private letterbox for addressed letters; public mailboxes unchanged | **Confirmed, amended.** | Amendments binding on the letters proposal: (a) a recipient can switch "Receive letters" off entirely; (b) the home letterbox must **not** be an interactable of kind `mailbox` (public `mailRead` would serve it to anyone in range — `interactions/index.ts` `mailboxInRange` accepts any resolved `mailbox`); (c) the server validates the recipient profile exists and is not banned — the client's "people you've met" list is only a convenience; (d) letters never enter World Memory or the Gazette. |
| D3 | Home map pins opt-in, off by default | **Confirmed, amended.** | Amendment: a pin is never sent to a player who is in a block relation with the owner (either direction), filtered server-side per recipient, and a ban / build-ban hides it without waiting for a restart. Binding on Brief H. |
| D4 | No currency for now | **Confirmed.** | No currency without a use; any future one earned-only, never money (hard limit). The Home panel's "A gentle currency" card stays as a planned idea. |
| D5 | Co-building by invitation, on your home only, anti-pinning rule | **Confirmed, amended.** | As written it lets the **owner** build on a helper's piece; today's rule refuses removing a piece others rest on (`server/src/building/index.ts` remove), so the helper would be griefed out of their own piece — a hard-limit breach. Amended support rule: a piece may rest only on pieces of its own builder, or — for an accepted helper, inside the owner's home rect + 1 m — on the **owner's** pieces. The owner never rests on helper pieces; helpers never rest on other helpers' pieces. Hence every helper can always remove their own pieces top-down, and the owner can always remove anything in the home (cascading helper dependents, with a notice). Removing your own piece never requires entering a latched home (range-only, as today). Helper pieces count against the helper's cap. |
| D6 | Built doors may close and latch; nobody can be trapped | **Confirmed in principle, amended; not built before #7.** | The proposed mechanism (an "auto-open when someone inside walks into it" step in the server move handler, and "inside" from the render-only, any-owner `enclosureAt`) puts a special case into the movement path every player uses every tick and decides an authority question with a geometric helper never meant for it. Binding constraints for any doors proposal: (a) exit from a home never depends on an interaction, timing or the client; (b) "inside" comes from the owner-only home room recorded by Brief H's rules, not from any-owner geometry; (c) a door cannot be latched while any non-owner, non-helper player is inside the home rect or within 1.5 m of the doorway; (d) Unstuck always works; (e) any change to `resolveMovement` / `handleMove` goes behind a flag with a level-0 equivalence property test, as the stairs item requires. |

## Evidence and reasoning per proposal

### 1. Make this my home — approved with changes (Brief H)

Checked: `shared/src/buildEnclosure.ts` (340 lines; `enclosureAt(index, p)` takes a **point**, is
"geometric only: pieces of any owner count"), `shared/src/building.ts` (`PieceIndex.ownedBy`
l.603), `server/src/building/index.ts` (cached `snapshotChunks()` l.395, `adminRemove` l.655,
`adminRemoveProfile` l.667), `server/src/persistence/migrations.ts` (1-5),
`client/src/ui/panels/SimplePanels.tsx` (`HomePanel`, `FUTURE`), `client/src/build/BuildUi.tsx`
(`NamePrompt` l.623), `scripts/e2e-all.mjs`, `scripts/e2e-combined.mjs`,
`server/test/persistence.test.ts`.

Real, fixable defects in the proposal (none is a reason to reject; all are written into Brief H):

1. **Neighbour griefing through `enclosureAt`.** Because `enclosureAt` merges touching roofs of any
   owner not separated by a wall and returns null over 12 m, a neighbour could build a roof against
   an open side of your house and make it "not a house", clearing your home. Brief H computes the
   home's room from an index of the **owner's pieces only**.
2. **Stale `rect_json`.** The room changes when the owner adds or removes pieces; storing it goes
   stale. The table stores the door piece; the room is recomputed from the owner's pieces at load
   and after every owner place/remove within 1 m of it.
3. **Snapshot cache.** The first build snapshot chunk is cached until the next *piece* change;
   embedding homes in it would serve stale homes. Homes go in their own `S2C.homes` message, sent
   after the snapshot (and after `C2S.buildSync`).
4. **Port clash.** `HOMES_PORT 2644` is already `CAMERA_PORT 2644` (`e2e-all.mjs`). Now 2671.
5. **Migration #6 breaks two existing checks the committee did not mention:** `e2e-combined.mjs`
   check 6 asserts `schema_migrations` is exactly `[1,2,3,4,5]` (l.1111) and
   `server/test/persistence.test.ts` l.41 expects `[1, 2, 3, 4, 5]`. Brief H owns those two
   assertions and makes them read the expected ids from the migrations list.
6. **"· 2 inside"** must count only real players, from positions the viewer's room instance syncs
   (same scope as the online count; README limitation), never an estimate.

Size M is credible once mail, guest book, helpers and doors stay out (they do).

### 2. Frame meter and chunked build instancing — approved with changes (Brief P)

Checked: `client/src/build/BuildLayer.tsx` (759 lines; `mesh.computeBoundingSphere()` l.388 over all
instances of a group; `groupKey` l.89; `aCut` l.314/382/613; `buildRender` debug section l.257-272),
`client/src/game/perf.ts`, `client/src/world/World.tsx` (dev-only hook l.98), README.

- The lever is real (confirmed l.388).
- **Measurement defect 1:** `buildRender.drawCalls/triangles` sums every group with instances
  (l.261-268) and ignores frustum culling, so it would show **no** improvement from chunking. The
  "after" numbers must come from the renderer (`buildRender.frame` already reads `gl.info.render`
  in production) plus a new visible-only count.
- **Measurement defect 2:** the baseline script was to run on a production build at fixed `?time=`
  and views — but `?time=` and `?cam=` are **dev-only** overrides (README, `World.tsx`), and time
  of day swings calls by ~40% (README "Rendering cost"). The baseline runs against the dev client
  (tsx server + Vite, like `e2e-player`).
- `buildRender.frame` already gives production-safe calls/triangles; the new part of the meter is
  frame time (p50/p95) and FPS.
- No adaptive quality (correctly left out).

### 3. Tap-to-move takes the gaps you can walk — approved with changes (Brief N)

Checked: `client/src/player/pathfinding.ts` (`cell` 0.5, `margin` 0.1, radius 0.4, cell-centre
sampling l.87-123), `navigation.ts`, `scripts/e2e-doors.mjs`, `shared/src/world/buildings.ts`
(House 1 at (-29, 5.5), House 2 at (-40.5, 6), both grown to 7.6 x 6.8).

- The cause is plausible but **unproven**: the current `e2e-results/doors.json` only holds a Town
  Hall run, and "detour" in `e2e-doors.mjs` (l.18, l.201) means a re-aimed *tap*, not a long path.
  The gap may also hold props or fences. Brief N must reproduce first in a unit test and stop with
  "not a bug" if the true swept circle cannot pass.
- `NavGrid` is also used by `client/src/build/sync.ts` (`refreshNavRect`), owned by Brief H: the
  public API must not change.
- Cycle 1 QA may fix this; then Brief N is skipped.

### 4. Hip roofs with real tile courses — approved with changes (Brief R)

Checked: `client/src/build/meshes2.ts` `houseRoof` l.47-60 (hip → kit `pavilionRoof`; params now
carry `overhang`), `client/src/world/arch/kit.ts` (`pavilionRoof` l.323 already has flat strip
courses, not scallops; `roof` l.259 scallops), `scripts/e2e-roofs.mjs`.

- **Correction:** the hip roof is not "a plain pyramid" — it has strip courses; it lacks the
  scalloped tiles, ridge/hip caps and curved eaves of the gable.
- **Missed:** `pavilionRoof` is used by **town buildings** (`arch/walkin.ts` l.494/668,
  `arch/buildings.ts` l.239/433). Editing the kit would change the town. Brief R writes a new hip
  generator inside `meshes2.ts` and does not touch `kit.ts`.
- **Missed:** `e2e:roofs` defaults to port **2634** (`ROOFS_PORT ?? 2634`), the same as `e2e:build`,
  and is **not** in the `e2e-all.mjs` suite list, so "still green via e2e:all" (proposal 1) would
  not run it. Brief R moves it to 2674 and registers it.
- Size S holds.

### 5. Letters and the Post House — deferred (cycle 03, first)

L by the committee's own estimate, and it changes world data: `worldDataHash` changes, so
`server-integration` must be refreshed. It also needs a resolver chain:
`registerInteractableResolver` holds one function (`shared/src/world/interactables.ts` l.435),
already used by building on both sides (`client/src/build/sync.ts` l.242,
`server/src/building/index.ts` l.216). Its home-mailbox half needs #1 merged. It is too big to run
next to #1 and still verify with two browsers. It comes back with the D2 amendments.

### 6. Your home's guest book — deferred (cycle 03)

Depends on #1 merged (home identity and `server/src/homes/`, owned by Brief H this cycle). The
design is sound: off `state.activities`, owner removal and send-side block checks marked as new
code. Bundle with letters next cycle; both need the same "per-home thing near the door" render
and interact path.

### 7. Help build my home (helpers) — deferred (cycle 03/04)

Depends on #1. It changes the support rulebook (`validatePlacement`, cascade/remove rules in
`shared/src/building.ts`) that every placement uses. As written it breaches the hard limit (the
owner building on a helper's piece pins the helper's piece; see D5). Rebuild on the amended D5
rule with migration #7.

### 8. The Workshop never runs dry — deferred, stage 1 split out

Checked: `shared/src/activities.ts` (`PROJECTS` l.345, dead-end line l.477). The dead end is real.

As one item it is S-M and touches `BuildUi.tsx` (owned by Brief H), `shared/src/building.ts`,
protocol and the activity suites' env. **Stage 1** (three outdoor-outcome projects, data +
`Outdoor.tsx` art, no unlocks, no anti-farming change) touches none of this cycle's files and is
first in line next cycle. **Stage 2** (glaze unlocks + `WORKSHOP_MIN_PROFILE_AGE_MINUTES`) follows.

### 9. Doors that close, and a latch for your home — deferred

Depends on #1 and #7. The proposed mechanism changes the core movement path (see D6). A closed
leaf toggling a shared dynamic collider also creates client/server misprediction windows (state
arrives by `S2C.buildUpdated`) and needs per-viewer pathing. It must be redesigned to the D6
constraints.

## File ownership (this cycle)

Exclusive owners. Anything not listed is read-only for all four briefs.

| Area | Owner |
|---|---|
| `shared/src/homes.ts` (new), `server/src/homes/**` (new), `server/src/services.ts`, `server/src/building/index.ts`, `server/src/persistence/migrations.ts` (+ new repository code under `server/src/homes/`), `shared/src/config.ts` (one `home` rate-limit entry), `shared/src/index.ts` (one export line), `client/src/build/BuildUi.tsx`, `client/src/build/sync.ts`, new `client/src/build/homes.ts`, `client/src/ui/panels/SimplePanels.tsx`, `client/src/ui/panels/MapPanel.tsx`, `server/src/gazette/templates.ts` (one template), `scripts/e2e-homes.mjs` (new), the migration assertions in `scripts/e2e-combined.mjs` (check 6/6b lines only) and `server/test/persistence.test.ts` (the `[1..5]` line only), new `shared/test/homes.test.ts`, `server/test/homes.test.ts` | **H** |
| `client/src/build/BuildLayer.tsx`, `client/src/build/picking.ts`, `client/src/game/perf.ts`, `client/src/ui/panels/SettingsPanel.tsx`, `scripts/perf-baseline.mjs` (new), `docs/perf/**` (new), new `client/test/buildChunks.test.ts`, `client/test/frameMeter.test.ts` | **P** |
| `client/src/player/pathfinding.ts`, `client/src/player/navigation.ts`, `scripts/e2e-doors.mjs`, new `client/test/navGaps.test.ts` | **N** |
| `client/src/build/meshes2.ts`, `scripts/e2e-roofs.mjs`, `scripts/roof-screenshots.mjs` (hip views), new `client/test/hipRoof.test.ts`, `docs/screenshots/build/house-hip-*` | **R** |

**Shared files and rules:**

- **`shared/src/protocol.ts`:** additions only (H is the only brief that needs any).
- **`package.json`:** one script line each, only where a new script exists: H `e2e:homes`,
  P `perf:baseline`.
- **`scripts/e2e-all.mjs`:** exactly one entry each, nothing else in the file.
  - H: `SUITES` entry `homes` (`HOMES_PORT` 2671).
  - R: `SUITES` entry `roofs` (`ROOFS_PORT` 2674).
  - P: `OPTIONAL` entry `perf` (dev client; `PERF_SERVER_PORT` 2672, `PERF_VITE_PORT` 2673).
  - N: `OPTIONAL` entry `doors` (existing `DOORS_PORT` 2643; long diagnostic, so not in the default list).
- **`README.md` / `docs/ARCHITECTURE.md`:** each brief edits only its own paragraphs.
  - H: the Future features "home" bullet, a new "Homes" subsection, its Testing row, and the "1-5" wording in the combined row.
  - P: the Player building measurements, the Rendering cost section and the Settings mention.
  - N: the click-to-move notes.
  - R: the triangle table entry for hips and the hip limitation sentence.
- **`scripts/lib/browser.mjs`:** append-only new helpers; no edits to existing ones.
- **Existing test files:** not edited, except H's single persistence line.

**Merge order:** N (or skipped), then R, then P, then H. H goes last because it is the largest and
its regression run should cover the other three. Each rebases and reruns its regression list
before merging.

**Common rules:**

- Real multiplayer only; no bots or invented activity; server-authoritative.
- No money, paid or external services; procedural assets only.
- Desktop and phone.
- Zero console errors in every browser run.
- "Twice in a row" means two consecutive green runs of the named suite on a quiet machine.
- No AI or model names in code or docs.

---

### Brief H — Make this my home (migration #6)

**Goal.** A player who has built a house can make it their home. Walking up to it shows whose home
it is. The Home panel stops saying "Not yet". The owner may show it on the island map (opt-in).

**Scope in.**

1. **The rule.** Pure `shared/src/homes.ts`: `houseFor(ownerPieces, pieceId)`.
   - It builds a `PieceIndex` from the **owner's pieces only**.
   - It finds the room with `enclosureAt` at a point inside the selected piece's house (for a wall
     or doorway, step 0.6 m inward along each normal; for a roof or floor, its centre).
   - It requires:
     - a `roofed` room;
     - at least 4 of the owner's wall-type pieces on the outline, at least one a `doorway`;
     - the room's cover includes the owner's `house_roof` or legacy roof.
   - It returns `{ rect, parts, doorPieceId, roofPieceIds, wallPieceIds, signPieceId? }`. The name is
     the text of the owner's facade name sign mounted on an outline wall, if any.
   - Pieces of other owners never affect the result.
2. **Migration #6.** Table `homes`:
   - `world_id TEXT`, `profile_id TEXT`, `door_piece_id TEXT NOT NULL`,
     `show_on_map BOOLEAN NOT NULL DEFAULT false`, `created_at BIGINT NOT NULL`;
   - `PRIMARY KEY (world_id, profile_id)`, `UNIQUE (world_id, door_piece_id)`.
   - No stored rect.
3. **Server: `server/src/homes/`**, a `RoomHooks` service registered in `services.ts`.
   - Messages (rate-limit action `home` in `CONFIG.rateLimits`):
     - `C2S.homeSet {pieceId}`: owner of the piece only. Refused while build-banned. A second set
       moves the home.
     - `C2S.homeClear`.
     - `C2S.homePin {on}`.
   - Each answers with `S2C.homeResult {ok, reason?, text?}`.
   - After every place or remove of the **owner's** pieces within 1 m of a home's rect, re-run
     `houseFor`. If it fails, clear the home, delete the row and send the owner a notice. This
     includes cascades, `adminRemove`, `adminRemoveProfile` and the owner's own removals.
   - Load all homes at room create; drop rows whose door piece no longer exists.
4. **Sync** (not in the Colyseus schema).
   - `S2C.homes {homes: HomeWire[]}` is sent to each joiner after the build snapshot and after
     `C2S.buildSync`. `HomeWire` = profile id, owner name, door piece id, name, rect, pinned.
   - `S2C.homeChanged {home | {profileId, cleared: true}}` goes to every room instance of the world.
   - Per-recipient filtering, server-side:
     - `pinned` is reported as false to anyone in a block relation with the owner;
     - homes of banned or build-banned owners are sent unpinned;
     - creating or lifting a sanction re-sends that owner's `homeChanged`.
5. **Client.**
   - `BuildUi.tsx`:
     - the selection card on your own piece of a qualifying house shows **Make this my home**,
       or **This is your home** with **Stop calling this home**;
     - a refusal shows its reason text;
     - `NamePrompt` shows "Fern Cottage · Ivy's home" (or "Ivy's home") plus "· N inside" when
       N ≥ 1. N counts players whose synced positions in the viewer's room are inside the rect;
       nothing is shown for 0 and nothing is estimated.
   - `SimplePanels.tsx` `HomePanel`:
     - with a home: its name and place, **Show my home on the map** (off by default),
       **Stop calling this home**, and the remaining "Planned" cards (letters, building with
       friends, decorating, shops, currency);
     - without one: how to make one;
     - the "A home of your own" planned card is replaced by the working feature; every other
       planned card stays.
   - `MapPanel.tsx`: a quiet pin "Fern Cottage · Ivy" for pinned homes. It never shows online
     status.
   - New `client/src/build/homes.ts` (store + read-only `snapshot().homes`), fed from `sync.ts`.
6. **Memory.** `home_made` (once per profile per door piece) and a Gazette template: "Ivy made
   Fern Cottage their home". No location is recorded.

**Scope out.**

- Letters / home mailbox, guest book, helpers, doors (later cycles).
- Houses 3-5 (closed).
- Any change to `validatePlacement`, `buildEnclosure.ts`, `BuildLayer.tsx` or meshes.
- No new render objects.

**Files owned.** See the ownership table (row H).

**Acceptance criteria.**

1. `shared/test/homes.test.ts` covers:
   - a qualifying 4x4 hut;
   - no doorway → refused;
   - no roof → refused;
   - another owner's roof over your walls → refused;
   - an L house with two of your roofs → one home;
   - the name from your boundary name sign, but not from someone else's sign;
   - **a neighbour's roof built against an open side does not change your result**;
   - selecting a wall, a doorway, the roof or a floor tile of the same house gives the same home.
2. `server/test/homes.test.ts` covers:
   - one home per profile (a second set moves it);
   - a forged `homeSet` on another player's house or on a non-house → refused with reason;
   - removing a wall so it no longer qualifies → cleared + notice;
   - `adminRemove` of its roof and `adminRemoveProfile` → cleared;
   - a neighbour's place/remove next to it → unchanged;
   - `homePin` toggles;
   - a blocked viewer and a viewer who blocked the owner receive `pinned: false`;
   - a build-ban hides the pin at once;
   - rate limit enforced;
   - a restart reloads homes; a home whose door piece vanished while the server was down is
     dropped.
3. Migration #6 applies on a fresh DB and on a DB at 1-5 (persistence test). The persistence
   assertion and `e2e-combined` check 6/6b read the expected id list from the migrations module,
   and pass.
4. `npm test` and `npm run typecheck` are green.
5. `npm run e2e:homes` (new; `HOMES_PORT` 2671; fresh data dir; desktop A + Pixel 7 touch B;
   registered in `e2e-all.mjs`) passes twice in a row with these named checks:
   1. A builds a hut through the real UI and makes it home. Both snapshots list the home.
   2. B walks up by tap-to-move and sees "· A's home · 1 inside" while A stands inside, and no
      count once A leaves.
   3. B's map has no pin by default. A switches the pin on; B's map shows it within 2 s.
   4. B blocks A: B's map loses the pin. B unblocks A: the pin is back.
   5. A removes the roof: the home is cleared on both and A sees the notice.
   6. A re-roofs and makes it home again. Server restart: the home and pin are intact, and a late
      joiner C sees the label and pin.
   7. A forged `homeSet` from B on A's house, and one on a bare floor tile, are refused with
      reasons.
   8. Zero console errors on every page.
6. Screenshots (reviewed, `docs/screenshots/homes/`): the Home panel with and without a home
   (desktop and phone), the approach label, and the map pin. Review bar: quiet, matches the
   existing panels, nothing labelled "Planned" is presented as working.
7. Still green via `npm run e2e:all`: acceptance, interiors, activities, build, build2, combined,
   built-interiors, phone, camera, roofs. Also `smoke`.

---

### Brief P — Frame meter and chunked build instancing

**Goal.** Build pieces off-screen stop being drawn. A production-safe frame meter exists that a
tester can read on a real device later.

**Scope in.**

1. `BuildLayer.tsx`: the group key gains a spatial chunk (cell size a constant, chosen from the
   measurements; start at 24 m). Each chunk group keeps its own bounding sphere, recomputed on
   change.
   - Per-instance `aFade` / `aCut`, the fade/cutaway updates, sign textures, glow halos and
     `picking.ts` keep working across chunks.
   - `buildRender` gains `visible: {drawCalls, triangles}`, computed by testing each mesh's
     bounding sphere against the camera frustum. The existing fields keep their meaning.
2. `perf.ts`: a frame-time ring buffer (~300 frames) and `snapshot().frame`: `{fps, p50Ms, p95Ms,
   calls, triangles}` (calls and triangles from `gl.info.render`). Works in production builds.
3. `SettingsPanel.tsx`: one quiet "Performance" line under Graphics (fps · typical / slow frame ms
   · draw calls). Desktop and phone. Nothing leaves the device.
4. New `scripts/perf-baseline.mjs` (`npm run perf:baseline`).
   - It runs against the **dev client**: tsx server on `PERF_SERVER_PORT` 2672 and Vite on
     `PERF_VITE_PORT` 2673, fresh data dir, because `?time=` / `?cam=` are dev-only.
   - It seeds the 2,000-piece mix through the real server path (`scripts/build-scale.mts` logic).
   - It reads `snapshot().buildRender` (all and visible) and `snapshot().frame` at `?time=0.5`,
     medium quality, for three views:
     - the default spawn;
     - `?cam=town_square`;
     - a corner view with no pieces.
   - It writes `docs/perf/baseline.json` and exits non-zero if visible build triangles or
     whole-frame calls regress by more than 10% against the committed file.
   - Registered as `OPTIONAL` `perf` in `e2e-all.mjs`.

**Scope out.**

- Adaptive quality, distance LOD, mesh trims, world (non-build) meshes.
- Any change to cutaway behaviour.

**Acceptance criteria.**

1. Before numbers first: the unchanged code plus only the new `visible` counter and the script,
   committed as `docs/perf/baseline-before.json`.
2. After, at `?time=0.5`, medium quality, 2,000 pieces, in `docs/perf/baseline.json` and the README:
   - **Corner view:** visible build triangles drop by at least 60%.
   - **Default view:** visible build triangles drop by at least 25% and whole-frame calls rise by
     no more than 15%.
   - **Busiest view (the one showing the most pieces):** whole-frame calls rise by no more than
     25%.
   - If a target is missed, the brief is not done. Report the numbers for two other chunk sizes
     and stop for a decision.
3. Unit tests:
   - `client/test/buildChunks.test.ts`:
     - chunk assignment is deterministic;
     - remove + place lands in the right chunk;
     - a 12 m roof crossing a chunk edge is in exactly one group;
     - every piece id maps to exactly one (group, index), with its fade/cut slot, after a burst
       of adds and removes.
   - `client/test/frameMeter.test.ts`: ring-buffer p50/p95 and fps.
4. `npm test` and `npm run typecheck` are green. `npm run perf:baseline` passes twice in a row.
5. Screenshots of the Settings line on desktop and phone (`docs/screenshots/perf/`).
6. Still green via `e2e:all`:
   - built-interiors (cutaway, picking through cut walls), build, build2, roofs, combined, phone,
     camera;
   - `node scripts/e2e-player.mjs`.

---

### Brief N — Tap-to-move takes the gaps you can walk (skip if cycle 1 QA already fixed it)

**First step.** Run `npm run build && npm run e2e:doors -- --doors house_2 --spawns 2` and read the
cycle 1 QA notes. If the route no longer detours, **stop**: mark the backlog row built by QA. The
unit test in criterion 1 may still be added as a chore.

**Goal.** Click/tap-to-move paths go through gaps the character can really walk.

**Scope in.**

1. Reproduce in `client/test/navGaps.test.ts` with the real world colliders: the path from the
   repro start to the House 2 apron, and its length against straight-line distance.
2. Measure the true gap with `resolveMovement` (a swept 0.4 m circle). **If it cannot pass, close
   the row as "not a bug"** (with the measured width) and change nothing.
3. Otherwise fix `NavGrid` sampling inside `pathfinding.ts` / `navigation.ts`, for example:
   - corner-aware or finer sampling only where the coarse grid is blocked but the true circle fits;
   - or verifying candidate cells with `isWalkable` at radius + 0.02 m.
4. The public API of `NavGrid` / `findPath` / `refreshRect` stays unchanged (`client/src/build/sync.ts`
   calls it).
5. `e2e-doors.mjs` gains a per-route "stops short" field: path ended more than 1 m from the goal.

**Scope out.** Server movement, shared collision, the notice-board stall (only the new
"stops short" field watches for it).

**Acceptance criteria.**

1. `client/test/navGaps.test.ts`:
   - the House 1 / House 2 route goes through the gap, within 15% of straight-line length, every
     segment walkable by `resolveMovement` (no correction);
   - a synthetic 0.95 m gap between two built walls is pathable; 0.7 m is not;
   - grid build time and a 60 m path time are at most 1.5x today's, measured in the test against
     the old settings.
2. The existing `client/test/pathfinding.test.ts` is green, unchanged.
3. `npm run e2e:doors -- --doors house_2 --spawns 2`: no detour on that route.
   - A full `npm run e2e:doors` shows no new detours, no stalls, and zero "stops short" routes.
   - Before and after tables go in the PR.
   - `doors` is registered as `OPTIONAL` in `e2e-all.mjs`.
4. `npm test` and typecheck are green. `node scripts/e2e-player.mjs` (click/tap-to-move,
   collision) is green twice in a row. Also via `e2e:all`: interiors, phone, combined.

---

### Brief R — Hip roofs with real tile courses

**Goal.** A hip-roofed player house looks as finished as a gable one: scalloped tile courses on
every facet, caps along the ridge and the four hips, the same eaves.

**Scope in.**

1. A new hip generator **inside `client/src/build/meshes2.ts`**, used by `houseRoof` for
   `style: 'hip'`.
   - Same `RoofParams`, including `overhang`.
   - Same footprint, height (`roofRise`) and eave line as today, so supports, placement, the
     cutaway (`aCut` clip heights) and picking are unaffected.
   - `client/src/world/arch/kit.ts` is **not** edited: the town's hip roofs stay as they are.
2. `scripts/e2e-roofs.mjs`:
   - default `ROOFS_PORT` 2634 → **2674** (clash with `e2e:build`);
   - registered in `SUITES`;
   - gains one check: a hip roof placed through the roof tool is seen by both clients, with the
     triangle count reported from `buildRender`.
3. Hip views in `scripts/roof-screenshots.mjs`.

**Scope out.** Joined L/T/U roofs, the town kit, gable roofs, legacy tiles, params or data.

**Acceptance criteria.**

1. `client/test/hipRoof.test.ts`, for sizes 2x2 to 12x12 (both orientations) and both pitches:
   - facet edges meet within 1 mm along hips and ridge (no gaps);
   - the highest point is `roofRise(params)` ± 0.02 m above the eave datum used today;
   - the bounding box is within 0.02 m of today's hip in X/Z;
   - triangles ≤ the same-size gable.
2. The README triangle table carries the new 4x6 hip count (from 854). The "hip roofs plainer"
   limitation is removed.
3. Before/after screenshots (`house-hip-*` day/night, desktop and phones) next to
   `house-gable-vs-town-*`, reviewed for the same craft bar. The town's own hip roofs are
   unchanged in `docs/screenshots/interiors/` exterior shots (compare one view).
4. `npm test` and typecheck are green. `npm run e2e:roofs` passes twice in a row on port 2674.
   Also via `e2e:all`: build, build2, built-interiors.

## Recommended order for deferred items (cycle 03)

1. **Letters and the Post House (#5)**, with the D2 amendments and the resolver chain.
2. **Your home's guest book (#6)**, with #5 (same per-home door-side render/interact path).
3. **Workshop stage 1 (#8a)**: three outdoor-outcome projects, no unlocks. Stage 2 (glaze unlocks
   + profile-age rule with env override) after.
4. **Help build my home (#7)** on the amended D5 rule, migration #7.
5. **Stairs**, now that the frame meter exists (flag, level-0 equivalence test, Unstuck).
6. **Doors and latch (#9)**, redesigned to D6 constraints, after #7.
7. **Joined L roofs** (roof stage 2), after Brief R.

## For the committee next cycle

- Which public house opens after the Post House (House 4: Seed House for garden plots, or a reading
  room)? D1 says one per cycle at most.
- Whether letters may be addressed to anyone with a pinned home, or only to people you have been
  near (harassment surface vs. usefulness), within the D2 amendments.

## Needs the owner

Unchanged from cycle 01: real-device frame readings once Brief P's meter ships (owner-reserved
real-device check), and whether to verify a real Postgres / Supabase instance (hosted
infrastructure).
