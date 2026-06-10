---
task: "Verdict tribunal — model-diverse agent panel adjudicates enforcement-gate ask decisions"
effort: E3
effort_source: auto
phase: complete
progress: 45/45
verified: true
mode: interactive
started: 2026-06-10
updated: 2026-06-10
project: pulse
slug: 2026-06-10-pulse-verdict-tribunal
---

> Previous task ISA (P-600/P-601 agent actions, 36/36 complete, shipped PR #15) superseded — full record in git history of this file.

## Problem

The L0 enforcement gate (P-700, shipped v0.9.0) returns `allow | ask | deny`. `allow` proceeds, `deny` refuses — but `ask` has nowhere to go except a human. "Human-in-the-loop" currently means "human-in-every-loop": every judgment call the deterministic gate can't settle lands on an operator, which doesn't scale and wastes attention on calls an agent panel could adjudicate. RavenClaude's command-review tribunal shows the missing middle layer: N model-diverse agent seats vote, a deterministic aggregator rules, and only genuine uncertainty escalates to the human. Pulse has every ingredient — `agent:` dispatch, `parallel` semantics, sovereignty vocabulary with `model_class`, the gate primitive — but no tribunal pattern composing them.

## Vision

A pipeline author writes `tribunal:` next to `agent:` and `gate:`, names the seats and their lenses, and the L1 layer exists: the panel convenes concurrently on the bus, a monoculture panel is automatically diversified, a split panel calls its tiebreaker, an abstaining panel denies, and the verdict — every vote, every reason, the diversity record — lands append-only on the bus and in the payload. The governed-action stack stops being a diagram: L0's `ask` flows into L1, and only L1's `defer` reaches a person.

## Out of Scope

- Stage 4 composition (P-702): the full L0→L1→L2 layered pipeline and SOC containment demo — this task ships the L1 pattern, not the stack.
- Conditional branching in YAML (issue #22) — defer-routing to a gate step inside YAML waits for it; tribunal signals defer via fail-closed StepFailure or opt-in continue.
- Cortex-side seat agents or harnesses — seats are capability addresses; the fleet supplies them.
- Backbone-level diversity within one model_class (e.g. two distinct local models) — the envelope vocabulary cannot express it; recorded as known limit.
- Verdict persistence/dashboard (Stage 5 owns observability).
- Envelope signing.

## Constraints

- Capability injection only — tribunal never imports NATS/myelin; seats dispatch through the injected `AgentProvider`.
- Deterministic core is pure: aggregation, vote parsing, diversity checks have no I/O, mirroring `enforcement-gate.ts` (pure `evaluate`).
- Fail-closed invariants (Magnus' spec discipline): every ambiguous case — unparseable vote, seat failure, empty panel, malformed config — resolves toward deny/defer, never silent allow.
- Sovereignty outranks diversity: diversity reassignment may only move a seat in the restrictive direction (→ local-only); never loosens local-only to frontier.
- Gate/agent precedent governs primitive design: runner owns timers, providers receive AbortSignal only, `collect` defaults derive from name, lifecycle events via options sink.
- Bun + TypeScript strict; no empty catch blocks; existing 191 tests keep passing; zero new runtime dependencies.

## Goal

Pulse gains a `tribunal:` step primitive backed by a pure deterministic core (`src/lib/tribunal.ts`): N agent seats dispatched concurrently, model-diversity enforced with restrictive-only auto-reassignment, votes aggregated fail-closed to `allow | deny | defer`, split panels resolved by a tiebreaker seat, abstaining panels denied — proven by the three acceptance scenarios from the governance plan plus a runnable example consuming an L0 `ask`.

## Criteria

### Types & contracts
- [x] ISC-1: `src/types/tribunal.ts` exports `TribunalStepSpec` with `name`, `seats[]`, optional `tiebreaker`, `confidence_bar`, `on_defer`, `timeout_ms`, `collect`
- [x] ISC-2: `SeatSpec` carries `name`, `capability`, `prompt`, optional `sovereignty` reusing `AgentSovereignty` vocabulary
- [x] ISC-3: `SeatVote` type exported: `{seat, verdict: "allow"|"deny"|"abstain", confidence, reason}`
- [x] ISC-4: `TribunalVerdict` type exported: `{verdict: "allow"|"deny"|"defer", reason, votes[], diversity, tiebreak?}`
- [x] ISC-5: `TribunalEvent` lifecycle type exported: `tribunal.convened` / `tribunal.seat_voted` / `tribunal.tiebreak` / `tribunal.verdict`
- [x] ISC-6: `PipelineStep` union includes `{ tribunal: TribunalStepSpec }`; types re-exported via `src/types/pipeline.ts`
- [x] ISC-7: `src/index.ts` exports tribunal types + pure functions

### Pure core — vote parsing (fail-closed)
- [x] ISC-8: `parseSeatVote()` accepts structured object output and JSON-string output (including fenced ```json blocks)
- [x] ISC-9: `parseSeatVote()` coerces unparseable/malformed/missing-verdict output to `abstain` — never throws
- [x] ISC-10: `parseSeatVote()` clamps non-numeric or out-of-range confidence to 0

### Pure core — aggregation (fail-closed)
- [x] ISC-11: robust majority allow (`allows > denies + abstains`) with mean majority confidence ≥ bar → `allow`
- [x] ISC-12: majority deny (`denies > allows`) → `deny` regardless of confidence
- [x] ISC-13: robust majority allow with confidence below bar → `defer`
- [x] ISC-13.1: non-robust majority allow (`allows > denies` but `allows ≤ denies + abstains`) → `defer` (hidden votes could flip it)
- [x] ISC-14: abstains ≥ valid votes (`abstains ≥ allows + denies`) → `deny` (incapacitated panel denies)
- [x] ISC-15: all-abstain panel → `deny`
- [x] ISC-16: empty votes array → `deny` (degenerate fail-closed)
- [x] ISC-17: allow/deny tie → `tie` signal so the runner convenes the tiebreaker
- [x] ISC-18: Anti: `tribunal.ts` is pure — no imports of NATS, fs, fetch, or providers (grep probe)

### Pure core — model diversity (Gate 22)
- [x] ISC-19: `checkDiversity()` flags a panel of ≥2 seats sharing one declared `model_class` as monoculture
- [x] ISC-20: `reassignForDiversity()` flips exactly one seat restrictive-direction only (`frontier`/`any` → `local-only`)
- [x] ISC-21: Anti: reassignment never loosens `local-only` → `frontier`/`any` (sovereignty outranks diversity)
- [x] ISC-22: all-local-only monoculture proceeds unreassigned but aggregator downgrades `allow` → `defer` with diversity reason
- [x] ISC-23: post-hoc check: ≥2 seats reporting the identical `model` string downgrades `allow` → `defer`

### Step primitive — runner
- [x] ISC-24: `validateTribunal` rejects missing/empty `name`, absent or empty `seats`, malformed seat fields with path-qualified errors
- [x] ISC-25: seats dispatch concurrently via injected `agentProvider` (probe: timing or dispatch-order test)
- [x] ISC-26: seat prompts render `{field}` placeholders from payload via `renderPromptTemplate`
- [x] ISC-27: runner appends the JSON verdict-format instruction to every seat prompt
- [x] ISC-28: seat dispatch failure or timeout becomes an `abstain` vote — never a pipeline crash mid-panel
- [x] ISC-29: split panel dispatches the configured tiebreaker seat once and re-aggregates with its vote included
- [x] ISC-30: tie with no tiebreaker configured → `defer`
- [x] ISC-31: tie persisting after tiebreaker vote → `defer`
- [x] ISC-32: monoculture panel auto-reassigned before dispatch; reassignment recorded in `TribunalVerdict.diversity`
- [x] ISC-33: full `TribunalVerdict` merged into payload under `collect` (default `tribunal_${name}`)
- [x] ISC-34: `deny` verdict raises `StepFailure("tribunal:${name}")`
- [x] ISC-35: `defer` raises `StepFailure` by default; `on_defer: "continue"` opts into downstream handling (fail-closed default)
- [x] ISC-36: lifecycle events emitted via `onTribunalEvent` sink for convened/seat_voted/tiebreak/verdict
- [x] ISC-37: parent abort signal cancels in-flight seat dispatches
- [x] ISC-38: Anti: missing `agentProvider` with a tribunal step fails fast with a clear error — no silent hang
- [x] ISC-39: `retry:` wrapping a tribunal step composes (StepFailure propagates; test proves)

### Quality, example, ship
- [x] ISC-40: `tests/tribunal.test.ts` covers pure core: parsing, aggregation table, diversity rules
- [x] ISC-41: `tests/tribunal-step.test.ts` covers runner incl. the three plan acceptance scenarios (split→tiebreaker, monoculture→reassign, abstain→deny)
- [x] ISC-42: `bun test` full suite passes; `bun run typecheck` clean
- [x] ISC-43: `docs/verdict-tribunal.md` documents the pattern (L0 ask → L1 verdict, diversity rule, fail-closed table); CLAUDE.md primitive list updated to 8
- [x] ISC-44: `blueprint.yaml` gains governance entries: P-700 (done, retroactive) and P-701; example `examples/tribunal/` runs offline with MockAgentProvider consuming an L0 `ask`

## Test Strategy

| isc | type | check | tool |
|---|---|---|---|
| 1–7 | static | types compile, exports present | `bun run typecheck`, Grep |
| 8–23 | unit | pure core behavior table | `bun test tests/tribunal.test.ts` |
| 24–39 | unit | runner with MockAgentProvider | `bun test tests/tribunal-step.test.ts` |
| 40–42 | regression | full suite + typecheck | `bun test`, `tsc --noEmit` |
| 43 | inspection | docs accurate | Read |
| 44 | integration | example runs offline | `bun examples/tribunal/run-demo.ts` |

## Features

| name | satisfies | depends_on | parallelizable |
|---|---|---|---|
| tribunal types | ISC-1..7 | — | no (foundation) |
| pure core (parse/aggregate/diversity) | ISC-8..23 | types | no |
| tribunal step primitive | ISC-24..39 | pure core | no |
| tests | ISC-40..42 | core + primitive | partial |
| docs + blueprint + example | ISC-43..44 | all | yes |

## Decisions

- 2026-06-10: Tribunal is a primitive, not YAML composition — tiebreaker convening and seat reassignment are control flow YAML cannot express (conditional branching #22 still open); precedent: gate/agent are primitives.
- 2026-06-10: Fail-closed defer default — `defer` raises StepFailure unless `on_defer: "continue"`; a pipeline silently proceeding past an unresolved judgment call would bypass L2.
- 2026-06-10: Sovereignty outranks diversity — reassignment only restricts (→ local-only); an all-local-only panel keeps its monoculture and pays for it with allow→defer downgrade (human compensates where diversity is unattainable).
- 2026-06-10: refined: ISC-19/ISC-20 — `checkDiversity()`/`reassignForDiversity()` merged into one pure `planDiversity()` (check + restrictive reassignment are one decision); behavior verified as specified.
- 2026-06-10: sage review (PR #31) finding adopted — post-hoc monoculture check narrowed to the ALLOWING coalition; a denier sharing a model with an allower is not a monoculture grant.
- 2026-06-10: Advisor tool (Inference.ts --mode advisor) drops prompt args — 2 attempts, both received only the literal word "advisor". Sage bus review stands as the commitment-boundary second opinion; tool defect to investigate separately.
- 2026-06-10: show-your-math (delegation floor 2nd slot relaxed): all relevant source read directly in-session (6 files); an Explore agent would re-read the same files slower. Sage bus review at VERIFY is the substantive delegation.

## Changelog

- conjectured: post-hoc model diversity means "no two votes share an executing model".
  refuted_by: sage review on PR #31 — a tiebreaker (or any vote) sharing a model with a DENYING seat does not make the permission-granting coalition a monoculture.
  learned: diversity guards the coalition that grants permission, not the panel roster; deny is never downgraded, so duplicate models outside the allowing set are noise.
  criterion_now: ISC-23 (post-hoc check examines allowing votes only; two regression tests cover both directions).

## Verification

- ISC-1..7: `bun run typecheck` clean; exports Grep-confirmed in `src/index.ts` + `src/types/pipeline.ts`
- ISC-8..18: `bun test tests/tribunal.test.ts` — parsing/aggregation/diversity table, 30 tests pass
- ISC-18: `grep -cE "import .*(nats|node:fs|fetch|agent-provider)" src/lib/tribunal.ts` → 0
- ISC-19..23: planDiversity/checkPosthocDiversity/applyDiversityDowngrade tests pass (incl. allowing-coalition regression pair)
- ISC-24..39: `bun test tests/tribunal-step.test.ts` — 27 tests pass; three plan acceptance scenarios green (split→tiebreaker, monoculture→reassign with restricted dispatch asserted, abstain→deny)
- ISC-25: concurrency probe — maxInFlight ≥ 2, 3×40ms panel completes <100ms
- ISC-42: full suite `bun test` → 287 pass, 0 fail; `tsc --noEmit` clean
- ISC-43: `docs/verdict-tribunal.md` written; CLAUDE.md lists 8 primitives with tribunal bullet — Read-verified
- ISC-44: blueprint P-700 (done) + P-701 entries merged; `bun examples/tribunal/run-demo.ts` → L0 ASK convenes panel: scenario 1 ALLOW (0.85 ≥ 0.6), scenario 2 tiebreak → DENY, scenario 3 incapacitated → DENY
- Live deploy probe: `~/.config/metafactory/pkg/repos/pulse` at commit 9db242a, `arc-manifest.yaml version: 0.10.0`
- Shipped: PR #31 (squash-merged 2026-06-10T16:30:35Z), issue #30 closed, sage review verdict "approve with one question" — question resolved in follow-up commit
