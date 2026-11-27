# Ideas backlog

Running list of every idea from the ideas loop (see [README.md](README.md)).
Status: proposed / approved / deferred / built / rejected / parked.

| Idea | Type | Cycle proposed | Status | Note |
|---|---|---|---|---|
| Your house, your home (mailbox, guest book, map pin) | new feature | 01 | approved | Split in cycle 02. "Make this my home" (+ opt-in map pin) approved as cycle 02 Brief H, migration #6. Mailbox → letters row, guest book → home guest book row. |
| Stairs and walkable upper floors | update | 01 | deferred | Cycle 03, after Brief P's frame meter; flag, level-0 equivalence test, Unstuck. D6/stairs share the movement-path rule. |
| Built interiors you can read (clean cutaway for built houses) | update | 01 | built | Cycle 01 Brief A (cycle 1 combined QA pending). |
| A phone that shows the world (compact dock, peek sheets) | update | 01 | built | Cycle 01 Brief B (cycle 1 combined QA pending). |
| Frame budget and adaptive quality | performance | 01 | approved | Cycle 02 Brief P: production-safe frame meter, chunked build instancing, dev-client baseline. Adaptive quality still waits for real-device numbers. |
| Distance LOD for roofs / trees | performance | 01 | rejected | Orthographic camera: distance does not change on-screen size, so LOD would pop or save nothing. |
| The Workshop makes new pieces | new feature | 01 | deferred | Cycle 02 reshaped to colour unlocks (#8); stage 2 after the outdoor projects. |
| More Workshop projects with outdoor outcomes (no new pieces) | update | 01 | deferred | Cycle 02 #8 stage 1 split out: three outdoor projects, no unlocks; first-tier for cycle 03. |
| One roof for L, T and U houses (+ richer hip roofs) | update | 01 | deferred | Stage 1 (hip tile courses) approved as cycle 02 Brief R; joined L roofs after it. |
| One harness for the browser suites (+ tap-stall repro) | maintenance | 01 | built | Cycle 01 Brief C (`e2e:all`, `e2e:doors`; cycle 1 combined QA pending). |
| Re-run a single e2e check (`--only <check>`) | maintenance | 01 | rejected | Suites are sequential stories (restart checks depend on earlier state). |
| Garden plots | new feature | 01 | parked | First in line after the deferred items. |
| Shared rain and snow | update | 01 | parked | After the frame budget. |
| Keepers walk home and talk among themselves | update | 01 | parked | After the frame budget. |
| World-wide online count across instances | update | 01 | parked | Small; do as a chore. |
| Fix the phone tap-to-move stall to the Town Hall | maintenance | 01 | parked | Not reproduced; cycle 02 Brief N adds a per-route "stops short" field to the door audit. |
| Gifts: hand a curiosity to another player | new feature | 01 | parked | Needs accept/decline. |
| Event listings with "I'll come" | new feature | 01 | parked | After homes. |
| Move tool and repaint a placed piece | update | 01 | parked | Good filler work. |
| Blueprints | new feature | 01 | parked | Grief and art risk. |
| Display curiosities on built shelves | new feature | 01 | parked | Follows homes. |
| First-day postcard checklist | new feature | 01 | parked | Quest-log feel risk. |
| Opt-in friends / where is my friend | new feature | 01 | parked | Privacy design first. |
| Transparent window glass from outside | update | 01 | parked | Next rendering pass. |
| Fishing; music jam with the tin whistle | new feature | 01 | parked | Lower priority. |
| Client bundle size / code splitting | performance | 01 | parked | Measure first. |
| Test against real Postgres | maintenance | 01 | parked | Needs the owner (hosted infrastructure). |
| Migrate legacy roof tiles | maintenance | 01 | parked | After joined roofs. |
| Houses 3-5: claimable, public, or closed | update | 01 | approved | D1 ruled (cycle 02): public houses, one per cycle, never claimable. House 3 = Post House, deferred to cycle 03. |
| A gentle currency / buying pieces | new feature | 01 | parked | D4 ruled (cycle 02): no currency for now; revisit only with trading; never money. |
| Co-building permission | new feature | 01 | deferred | D5 ruled (cycle 02) with an amended support rule (owner never rests on helper pieces); proposal #7, cycle 03/04, migration #7. |
| Doors that close and lock | update | 01 | deferred | D6 ruled (cycle 02): allowed in principle under binding no-trap constraints; proposal #9 after #7. |
| Tap-to-move detours round House 1 (nav grid closes the House 1/House 2 gap) | maintenance | 01 | approved | Cycle 02 Brief N; skip if cycle 1 QA already fixed it. Repro: `npm run build && npm run e2e:doors -- --doors house_2 --spawns 2`. |
| Letters and the Post House (House 3 opens; private letterbox) | new feature | 02 | deferred | L; changes world data hash, needs a resolver chain and #1 merged. First in cycle 03, with the D2 amendments. |
| Your home's guest book | update | 02 | deferred | Needs #1 merged; cycle 03 with letters. |
| Help build my home (helpers) | new feature | 02 | deferred | As written breaks the no-griefing rule (owner could pin a helper's piece); rebuild on amended D5, migration #7. |
| The Workshop never runs dry (outdoor projects + glaze unlocks) | update | 02 | deferred | Stage 1 (outdoor projects) cycle 03; stage 2 (unlocks + profile-age rule with env override) after. Touches `BuildUi.tsx` owned by Brief H this cycle. |
| Doors that close, and a latch for your home | update | 02 | deferred | Proposed mechanism special-cases the move handler and uses render-only geometry for authority; redesign to D6 constraints after #7. |
| Hip roofs with real tile courses | update | 02 | approved | Cycle 02 Brief R; new generator in `meshes2.ts`, town kit untouched; moves `e2e:roofs` off port 2634 and into `e2e:all`. |
| Home map pins (opt-in) | update | 02 | approved | D3 ruled; part of Brief H; hidden from players in a block relation with the owner. |
| Claimable starter cottage | new feature | 02 | rejected | D1: no fair allocation for a scarce house. |
| Adaptive quality step-down | performance | 02 | parked | Needs real-device numbers from Brief P's meter (owner-reserved check). |
