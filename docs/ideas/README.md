# Ideas loop

Elsewhere improves in repeating cycles:

1. **Committee proposes.** Five seats (new player, regular builder, world/art director, engineer,
   community/moderation lead) brainstorm, argue and rank eight proposals — a deliberate mix of new
   features, updates to existing features, and performance/maintenance work.
2. **Vetter decides.** An independent vetting pass approves a few, rejects or parks the rest, and
   records why.
3. **Workers build** the approved proposals (in parallel where the proposals say they are
   independent), each with unit tests and a two-real-browser check.
4. **QA** verifies the result on desktop and phone, and its findings feed the next cycle.

Files per cycle (`NN` = cycle number, two digits):

- `cycle-NN-proposals.md` — the committee's ranked proposals, parked ideas and owner questions.
- `cycle-NN-decisions.md` — the vetter's decisions and reasons.
- `backlog.md` — the running table of every idea and its status
  (proposed / approved / built / rejected / parked).

Every idea must respect the product rules: real multiplayer only (no simulated players, counts or
activity), clearly labelled world characters, server-authoritative shared state, validated and
moderated player text, no secrets in the client, procedural assets only, no paid or new external
services, the warm handcrafted-miniature look, and desktop + phone support.
