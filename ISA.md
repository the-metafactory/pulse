---
task: "Governed-action stack — L0 gate, L1 tribunal, L2 human gate composed in-pipeline"
effort: E3
effort_source: auto
phase: complete
progress: 37/37
verified: true
mode: interactive
started: 2026-06-10
updated: 2026-06-10
project: pulse
slug: 2026-06-10-pulse-governed-pipeline
---

> Previous task ISA (P-701 verdict tribunal, 45/45 complete, shipped PR #31, v0.10.0) superseded — full record in git history of this file.

## Problem

The three governance layers exist but don't compose. L0 (enforcement gate, P-700) runs as a capability guard or a demo prelude; L1 (tribunal, P-701) is a pipeline step; L2 (`gate:`) is a separate step. Nothing routes between them: an L0 `allow` cannot skip the panel inside a pipeline, an L0 `ask` cannot convene it, and a tribunal `defer` has nowhere to go but StepFailure — the L2 escalation that justifies "human attention spent last" is unreachable. The containment demo fakes the stack with a run-script prelude and an honest README apology.

## Vision

One YAML block declares the whole stack: `governed:` names the tool, the policy, the panel, and the human gate. A pre-approved request flows through at zero LLM cost; a forbidden one dies deterministically; a judgment call convenes the tribunal; only genuine panel uncertainty opens the analyst gate. The containment demo runs all three layers in-pipeline, every layer's verdict rides the bus, and the run output reads like the governance plan's diagram come alive.

## Out of Scope

- Generic conditional branching (`switch:`/`when:`, issue #22) and payload predicates (#24) — governed routes internally, like tribunal's tiebreaker.
- Gate policy schema (veto windows, fleet caps — issue #23).
- Policy file loading inside the step (inline YAML policy only in v1; `policy-loader` stays the capability-guard path).
- Stage 5 dashboard (verdicts on the bus is this stage's job; reading them back is Stage 5's).
- Reply to Magnus / compass standard (Stages 6-8).

## Constraints

- Layers stay distinct mechanisms: L0 = pure `evaluate()` (no LLM), L1 = the existing tribunal runner, L2 = the existing gate runner. The primitive composes, never reimplements.
- Fail-closed at every joint: malformed policy → deny; tribunal deny → halt; defer without a configured gate → halt; gate fail → halt.
- L0 `allow` skips the panel entirely — zero agent dispatch (the cost thesis is testable).
- Pure core stays pure: no I/O added to enforcement-gate.ts or tribunal.ts.
- Gate/agent/tribunal precedent: runner owns timers, events via options sinks, `collect` default from name, StepRecords for every layer.
- Bun strict TS, zero new runtime deps, existing 287 tests keep passing.

## Goal

Pulse gains a `governed:` step primitive composing evaluate() → tribunal → gate with fail-closed routing (allow skips, ask convenes, deny halts, defer escalates to the gate, gate-fail halts), proven by unit tests for every routing path and by the containment demo running all three layers in-pipeline with each layer's verdict published to the bus.

## Criteria

### Types & contracts
- [x] ISC-1: `src/types/governed.ts` exports `GovernedStepSpec`: `name`, `tool`, `input_fields[]`, `policy` (inline), optional `tribunal` (seats config), optional `gate`, `collect`
- [x] ISC-2: `GovernedResult` exported: `outcome: "allow"|"deny"`, `resolved_by: "policy"|"tribunal"|"gate"`, `l0: GateDecision`, optional `tribunal: TribunalVerdict`, optional `gate: GateResult`
- [x] ISC-3: `GovernedEvent` exported: `governed.l0` / `governed.escalated` / `governed.resolved` lifecycle
- [x] ISC-4: `PipelineStep` union includes `{ governed: GovernedStepSpec }`; re-exports via types/pipeline.ts + index.ts

### Routing — the layered semantics
- [x] ISC-5: L0 `allow` → continue immediately; zero `agentProvider.dispatch` calls (probe: provider call count 0)
- [x] ISC-6: L0 `deny` → StepFailure naming the rule reason; tribunal never convened
- [x] ISC-7: L0 `ask` with tribunal configured → tribunal convenes with the spec's seats
- [x] ISC-8: Anti: L0 `ask` with NEITHER tribunal NOR gate configured → StepFailure (fail closed, no silent allow)
- [x] ISC-8.1: L0 `ask` with no tribunal but a configured gate → gate opens directly (L0→L2 degradation toward the human)
- [x] ISC-9: tribunal `allow` → continue; `resolved_by: "tribunal"`
- [x] ISC-10: tribunal `deny` → StepFailure carrying the tribunal reason
- [x] ISC-11: tribunal `defer` with gate configured → gate opens with a prompt carrying the defer reason
- [x] ISC-12: gate `pass` → continue; `resolved_by: "gate"`; outcome allow
- [x] ISC-13: gate `fail` → StepFailure carrying analyst notes
- [x] ISC-14: Anti: tribunal `defer` with NO gate configured → StepFailure (fail closed)
- [x] ISC-15: Anti: malformed/absent policy → StepFailure via L0 deny (evaluate's fail-closed paths exercised through the step)
- [x] ISC-16: `toolInput` built from `input_fields` payload values; missing field handled by evaluate's match semantics (no crash)

### Mechanics
- [x] ISC-17: full `GovernedResult` merged into payload under `collect` (default `governed_${name}`)
- [x] ISC-18: StepRecords pushed for the governed step AND the inner tribunal/gate (trace shows layers)
- [x] ISC-19: `GovernedEvent`s emitted via `onGovernedEvent`; inner tribunal/gate events still fire via their own sinks
- [x] ISC-20: validation rejects missing `name`/`tool`/`input_fields`/`policy`, malformed `tribunal`/`gate` sub-specs, with path-qualified errors
- [x] ISC-21: parent abort signal propagates through tribunal and gate sub-runs
- [x] ISC-22: `retry:` composes around `governed:` (StepFailure propagates; test proves)

### Tests
- [x] ISC-23: `tests/governed-step.test.ts` covers every routing path (ISC-5..16) with scripted providers
- [x] ISC-24: plan acceptance test: one run traverses all three layers (ask → defer → gate pass) with all three verdicts in the result
- [x] ISC-25: `bun test` full suite passes; typecheck clean

### Demo — containment runs the stack
- [x] ISC-26: `examples/containment-tribunal/pipeline.yaml` uses one `governed:` step (policy inline, tribunal seats, analyst gate) — run-demo L0 prelude removed
- [x] ISC-27: `--preapproved` scenario: sinkhole target → L0 allow → panel never convenes (zero-cost line in output)
- [x] ISC-28: `--protected` scenario: L0 deny in-pipeline (was prelude)
- [x] ISC-29: `--defer` scenario: low-confidence panel → defer → analyst gate opens (auto-pass default, `--interactive` for real verdict)
- [x] ISC-30: existing scenarios still correct: default ALLOW via tribunal, `--split` DENY via oracle, `--degraded` incapacitated DENY
- [x] ISC-31: each layer's verdict published to the bus as a `governance.verdict` envelope (demo wiring via transport; `nats sub` shows it)
- [x] ISC-32: README rewritten: stack in-pipeline, scenario matrix updated, Stage-4 apology removed

### Docs & ship
- [x] ISC-33: `docs/verdict-tribunal.md` gains the `governed:` composition section
- [x] ISC-34: CLAUDE.md + README primitive counts → 9 with `governed` row/bullet
- [x] ISC-35: blueprint.yaml: P-702 entry (depends P-700, P-701)
- [x] ISC-36: Anti: `examples/soc-triage/` and `examples/tribunal/` untouched; existing tribunal/gate tests unmodified

## Test Strategy

| isc | type | check | tool |
|---|---|---|---|
| 1–4 | static | exports, union compiles | typecheck, Grep |
| 5–22 | unit | routing table + mechanics | `bun test tests/governed-step.test.ts` |
| 23–25 | regression | suite + typecheck | `bun test`, tsc |
| 26–32 | integration | demo scenario runs | Bash runs + grep output |
| 33–35 | inspection | docs/blueprint | Read |
| 36 | diff scope | `git diff --stat` | Bash |

## Features

| name | satisfies | depends_on | parallelizable |
|---|---|---|---|
| governed types | ISC-1..4 | — | no (foundation) |
| governed runner + validation | ISC-5..22 | types | no |
| tests | ISC-23..25 | runner | no |
| demo upgrade | ISC-26..32 | runner | no |
| docs + blueprint | ISC-33..35 | all | yes |

## Decisions

- 2026-06-10: `governed:` is one composite primitive, not three chained steps — linear YAML cannot express "allow skips the panel" or "defer opens the gate" without #22; internal routing follows the tribunal-tiebreaker precedent. #22 stays the generic answer; governed is the specific stack.
- 2026-06-10: inline policy only (v1) — file loading belongs to the policy-loader/capability-guard path; the YAML block should read as one self-contained governance declaration.
- 2026-06-10: bus publication of layer verdicts is demo wiring (event sinks → transport.publish), not pulse-core coupling — pulse stays capability-injected; Stage 5 consumes the subjects.
- 2026-06-10: show-your-math (delegation 2nd slot): all three mechanisms built/read this session; sage at VERIFY is the substantive delegation.

## Changelog

- conjectured: an L0 `ask` without a tribunal must fail closed.
  refuted_by: FirstPrinciples pass — a deployment without a fleet still has a human; degrading ask to the gate (L0→L2) keeps every path fail-closed while keeping L1 optional.
  learned: escalation is monotone descent in certainty; layers are optional joints, but the descent must always terminate at deny or a MORE authoritative layer — never at silent allow.
  criterion_now: ISC-8 (neither → halt) + ISC-8.1 (no tribunal + gate → gate opens).

- conjectured: recovering an inner verdict via reverse-search of stepRecords is safe because the inner runner always records before throwing.
  refuted_by: sage PR #35 — abort paths record without a verdict field, so reverse-search can surface an EARLIER step's verdict in retry/multi-governed pipelines.
  learned: when recovering state from a shared accumulator after a failed call, slice from the pre-call length — never search the whole history.
  criterion_now: ISC-18 (catch paths recover only own-call records; fixed in follow-up commit).

## Verification

- ISC-1..4: typecheck clean; exports Grep-confirmed (types/governed.ts, pipeline.ts union, index.ts)
- ISC-5..22: `bun test tests/governed-step.test.ts` — 17 pass: full routing table (allow-skip with 0 dispatches, L0 deny, ask→tribunal allow/deny, defer→gate pass/fail, defer-no-gate fail-closed, ask-no-tribunal→gate degradation, ask-neither fail-closed, malformed policy deny, events sequence, records, retry composition, validation)
- ISC-24: all-three-layers test (ask → defer → gate pass, all verdicts in GovernedResult) + live demo --defer traverses L0/L1/L2
- ISC-25: `bun test` → 304 pass, 0 fail; tsc clean; blueprint lint OK
- ISC-26..30: all six scenarios probed post-sage-fix — default ALLOW/tribunal, --preapproved ALLOW/policy (0 seats), --protected DENY/policy, --split DENY/tribunal, --degraded DENY/tribunal, --defer ALLOW/gate
- ISC-31: transport-level NATS probe captured governance.verdict.{l0,tribunal,gate,resolved} on local.switch-soc.default.governance.verdict.* (defer run, live bus)
- ISC-32..35: README/docs/blueprint Read-verified; P-702 done in blueprint
- ISC-36: git status scope check — soc-triage + tribunal intro untouched; existing tests unmodified
- Sage: two review rounds; "blocker" (subdomain bypass) refuted empirically via loader probe + --protected scenario; 5 real findings fixed (own-record recovery, settled publishes, taxonomy, envelope sovereignty, demo-wiring honesty)
- Live deploy probe: ~/.config/metafactory/pkg/repos/pulse at v0.12.0 runs --defer → ALLOW resolved by GATE
- Shipped: PR #35 squash-merged, issue #34 closed, v0.12.0 deployed via arc
