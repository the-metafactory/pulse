# Pulse Decisions Log

## 2026-04-04 - NATS Phase 1: Transport package location
- Decision: Start as shared `packages/transport/` package from day one
- Rationale: Stage 2 (Grove) will need the same transport abstraction. Building shared from the start avoids extraction later.
- Alternatives rejected: `src/transport/` inside pulse (would need extraction for Grove)

## 2026-04-04 - NATS Phase 1: Auth from Stage 1 (DD-72 override)
- Decision: DD-72 wins — NATS accounts configured from Stage 1, not deferred to Stage 3
- Rationale: JC executive decision (2026-04-03). Single operator account + per-component users from day one. The migration path doc said "no auth for local-only" but DD-72 supersedes.
- Alternatives rejected: Deferring auth to Stage 3 federation (migration-path.md original plan)

## 2026-04-04 - NATS Phase 1: Cue consumer scope (P-501)
- Decision: Build receiving interfaces + mock cue emitter. Cue evaluation logic is not in scope.
- Rationale: The cue system (DD-62) isn't built in pulse yet. P-501 is about proving the subscription infrastructure works, not implementing cue evaluation. A mock emitter lets us validate the pipeline end-to-end.
- Alternatives rejected: Building full cue evaluation logic (too much scope for Phase 1)
