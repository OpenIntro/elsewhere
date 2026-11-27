# Ideas backlog

Running list of every idea from the ideas loop (see [README.md](README.md)).
Status: proposed / approved / deferred / built / rejected / parked.

| Idea | Type | Cycle proposed | Status | Note |
|---|---|---|---|---|
| Your house, your home (mailbox, guest book, map pin) | new feature | 01 | deferred | Cycle 01 vetting: L, not M; guest-book owner removal and send-side mail blocks do not exist yet. First in line next cycle, staged; needs committee decisions (mailbox semantics, map-pin default). Migration #6 reserved for it. |
| Stairs and walkable upper floors | update | 01 | deferred | L; shared collision has no level. After built interiors (cycle 01 Brief A) and the frame meter; behind `BUILD_UPSTAIRS`. |
| Built interiors you can read (clean cutaway for built houses) | update | 01 | approved | Cycle 01 Brief A. Client only, no extra draw calls. |
| A phone that shows the world (compact dock, peek sheets) | update | 01 | approved | Cycle 01 Brief B. Landscape-only collapsed dock this cycle; portrait dock unchanged. |
| Frame budget and adaptive quality | performance | 01 | deferred | Reshape: meter + baseline + spatially chunked build instancing; no distance LOD. Second next cycle. |
| Distance LOD for roofs / trees | performance | 01 | rejected | Orthographic camera: distance does not change on-screen size, so LOD would pop or save nothing. |
| The Workshop makes new pieces | new feature | 01 | deferred | Needs piece art, gating and an anti-farming rule with an env override. |
| More Workshop projects with outdoor outcomes (no new pieces) | update | 01 | parked | Chore: stops the Workshop dead-ending until unlocks land. |
| One roof for L, T and U houses (+ richer hip roofs) | update | 01 | deferred | Staged: hip tile courses (S) next; joined L roofs later; T/U after. |
| One harness for the browser suites (+ tap-stall repro) | maintenance | 01 | approved | Cycle 01 Brief C, reshaped: runner, shared server helper, port-clash fix, door-walk audit; no assertion rewrites. |
| Re-run a single e2e check (`--only <check>`) | maintenance | 01 | rejected | Suites are sequential stories (restart checks depend on earlier state). |
| Garden plots | new feature | 01 | parked | First in line after the deferred items. |
| Shared rain and snow | update | 01 | parked | After the frame budget. |
| Keepers walk home and talk among themselves | update | 01 | parked | After the frame budget. |
| World-wide online count across instances | update | 01 | parked | Small; do as a chore. |
| Fix the phone tap-to-move stall to the Town Hall | maintenance | 01 | parked | Not reproduced in 144 emulated-phone walks by `npm run e2e:doors` (cycle 01). Seen twice more by the phone-layout worker (activities check 5, phone check 9: stopped ~1.9 m short of the notice board). Cycle 01 QA to chase. |
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
| Houses 3-5: claimable, public, or closed | update | 01 | parked | Delegated: for the committee to decide next cycle. |
| A gentle currency / buying pieces | new feature | 01 | parked | Delegated: for the committee to decide next cycle (earned-only, no money). |
| Co-building permission | new feature | 01 | parked | Delegated: for the committee to decide next cycle (anti-pinning rule). |
| Doors that close and lock | update | 01 | parked | Delegated: for the committee to decide next cycle (no trapping). |
| Tap-to-move detours round House 1 (nav grid closes the House 1/House 2 gap) | maintenance | 01 | proposed | Found by the door audit. Repro: `npm run build && npm run e2e:doors -- --doors house_2 --spawns 2`. |
