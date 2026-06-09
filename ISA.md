---
task: "Agent actions — LLM/agent tasks as first-class Pulse steps via myelin envelopes on NATS"
effort: E3
phase: complete
progress: 36/36
started: 2026-06-09
updated: 2026-06-09
verified: true
project: pulse
slug: 2026-06-09-pulse-agent-actions
---

## Problem

Pulse runs deterministic tasks (TypeScript actions + composition primitives) but has no way to delegate a step to an LLM/agent on the cortex fleet. The metafactory bus (myelin envelopes over NATS) already carries capability-addressed tasks with sovereignty constraints, and cortex agents already consume `tasks.*.>` and emit `dispatch.task.*` lifecycle envelopes — but Pulse cannot ask the bus for work. Miner's D/A/H classification (P-301) has D (action) and H (gate) targets but no A (agentic) target. The NetSecWG presentation on agentic OS needs a demonstrable mixed deterministic/agentic flow.

## Vision

A pipeline author writes `- agent:` in YAML next to actions and gates, names a capability and a sovereignty policy, and the fleet does the rest — local model for confidential payloads, frontier model where policy allows, lifecycle visible on the bus. D/A/H becomes literal Pulse vocabulary: **D** = action, **A** = `agent:`, **H** = `gate:`. The demo makes a room of security engineers see policy travel *with* the data.

## Out of Scope

Bidding protocol (F-10) — offer/direct dispatch only in v1. Cue evaluation (cue daemon owns it). Trigger evaluation. Envelope signing (ed25519 chain) — envelopes are published unsigned on the local-only demo bus; signing lands with federation work. Streaming progress tokens into payload (lifecycle `progress` events observed, not merged). Cloud (Workers) mode for the agent capability — local mode only. Building cortex-side agents or harnesses. The presentation slides themselves (concurrent session owns them).

## Constraints

- Capability injection is the only dependency mechanism — actions/steps never import NATS or myelin directly.
- Myelin owns the envelope schema and subject grammar; pulse consumes `@the-metafactory/myelin` (or a vendored minimal builder if dependency is not consumable) — never invents subjects.
- Gate precedent governs primitive design: provider receives AbortSignal only; runner owns the timer; default `collect` derives from name.
- Payload vocabulary: flowing data is `payload`, injected services are `context`. Never mixed.
- No empty catch blocks. Bun + TypeScript strict. Tests in `tests/` mirroring `src/lib/`.
- Existing 145+ tests keep passing.

## Goal

Pulse dispatches agent tasks as first-class steps: an `agent` capability (injected) and an `agent` YAML step primitive, both backed by a pluggable `AgentProvider`, with a myelin/NATS provider that publishes task envelopes and awaits dispatch lifecycle completion — proven by a runnable CommunitySOC phishing-triage example mixing local-only and frontier-ok agent steps with an analyst gate.

## Criteria

### Types & contracts
- [x] ISC-1: `src/types/agent.ts` exports `AgentTaskSpec` with `capability`, `prompt`, optional `sovereignty`, `timeout_ms`, `distribution_mode` fields
- [x] ISC-2: `AgentTaskSpec.sovereignty` carries `model_class: "local-only" | "frontier" | "any"` and `frontier_ok: boolean` matching myelin v3 vocabulary
- [x] ISC-3: `src/types/agent.ts` exports `AgentTaskResult` with `task_id`, `output`, `status: "completed" | "failed"`, `duration_ms`, optional `model`/`usage`
- [x] ISC-4: `AgentProvider` interface exposes `dispatch(spec, opts: { signal? })` returning `Promise<AgentTaskResult>` — signal-only abort, mirroring GateProvider precedent
- [x] ISC-5: `ActionCapabilities` gains optional `agent?: (task: AgentTaskSpec) => Promise<AgentTaskResult>` member
- [x] ISC-6: `CapabilityName` union includes `"agent"`
- [x] ISC-7: `PipelineStep` union includes `{ agent: AgentStepSpec }`
- [x] ISC-8: `AgentStepSpec` includes `name`, `capability`, `prompt` (template), optional `sovereignty`, `timeout_ms`, `collect`
- [x] ISC-9: Omitted `collect` on agent step defaults to `agent_${name}` (gate-collision precedent)
- [x] ISC-10: `AgentEvent` lifecycle type exported: `agent.dispatched` / `agent.completed` / `agent.failed` / `agent.timeout`

### Step runner
- [x] ISC-11: `runStep` dispatches `{ agent: ... }` steps via injected `AgentProvider`
- [x] ISC-12: Agent step renders `{field}` placeholders in `prompt` from payload context before dispatch
- [x] ISC-13: Agent step merges result into payload under `collect` field, preserving passthrough (`{...payload, [collect]: result}`)
- [x] ISC-14: Agent step failure raises `StepFailure` so retry/parallel primitives can wrap agent steps
- [x] ISC-15: Runner owns timeout: `timeout_ms` aborts via AbortSignal and emits `agent.timeout`
- [x] ISC-16: `StepRunnerOptions` accepts `agentProvider` (via ActionRunnerOptions) and `onAgentEvent` hooks
- [x] ISC-17: `retry:` primitive wrapping an `agent:` step retries on dispatch failure (test proves composition)
- [x] ISC-18: Anti: missing `agentProvider` when pipeline contains agent step fails fast with clear error — no silent hang

### Providers
- [x] ISC-19: `MockAgentProvider` in `src/lib/agent-provider.ts` returns scripted results keyed by capability (test + demo fallback)
- [x] ISC-20: `MyelinAgentProvider` builds a myelin v3 envelope: `id`, `source`, `type: tasks.{capability}`, `timestamp`, `correlation_id = task_id`, sovereignty block, payload with `prompt`
- [x] ISC-21: `MyelinAgentProvider` publishes to offer subject `local.{principal}.{stack}.tasks.{capability}` (myelin grammar; direct mode uses `@{encoded-did}` segment)
- [x] ISC-22: `MyelinAgentProvider` subscribes to `dispatch.task.completed`/`failed` and resolves on matching `correlation_id`
- [x] ISC-23: `MyelinAgentProvider` rejects on signal abort and unsubscribes (no leaked subscriptions — test asserts cleanup)
- [x] ISC-24: Sovereignty fields from `AgentTaskSpec` are copied verbatim into envelope `sovereignty` block (probe: unit test asserts `model_class`/`frontier_ok` round-trip)
- [x] ISC-25: Anti: pulse never bypasses the bus — `MyelinAgentProvider` contains no direct HTTP/process call to any agent (probe: grep for fetch/spawn in provider)
- [x] ISC-26: NATS connectivity isolated behind a small transport seam so tests run without a NATS server (in-memory fake)

### Capability injection
- [x] ISC-27: Agent capability wired when an `AgentProvider` is configured (in `action-runner.ts` — refined, see Decisions)
- [x] ISC-28: Action manifest `requires: ["agent"]` validated like existing capability names; missing provider yields a clear action error

### Example & demo
- [x] ISC-29: `examples/soc-triage/` contains pipeline YAML with ≥2 agent steps (one `model_class: local-only`, one `frontier_ok: true`) and one `gate:` step
- [x] ISC-30: `A_SANITIZE_IOCS` deterministic action strips email PII between local and frontier agent steps (probe refined: exercised end-to-end by demo run with seeded fixture email)
- [x] ISC-31: `run-demo.ts` runs end-to-end with simulated fleet on in-memory transport — no network required (probe: `bun examples/soc-triage/run-demo.ts --auto-approve`)
- [x] ISC-32: Demo supports `--live` flag switching to NATS transport — live-probed against real nats-server on localhost:4222
- [x] ISC-33: `examples/soc-triage/README.md` documents demo narrative incl. `nats sub` command to show envelopes live
- [x] ISC-34: Sample phishing email fixture contains realistic IOCs but no real personal data (probe: read fixture)

### Quality & docs
- [x] ISC-35: `bun test` passes — 188 tests (145 pre-existing + 43 new in `tests/agent-step.test.ts` / `tests/agent-provider.test.ts`)
- [x] ISC-36: `docs/agent-actions.md` design doc covers contract, provider model, sovereignty routing, D/A/H mapping; CLAUDE.md primitives list updated; ADR 0001 supersession noted in design doc (ADR file is untracked WIP on main — refined, see Decisions)

## Test Strategy

| isc | type | check | tool |
|---|---|---|---|
| 1–10 | static | types compile, exports present | `bun run typecheck`, Grep |
| 11–18 | unit | step-runner behavior with MockAgentProvider | `bun test tests/agent-step.test.ts` |
| 19–26 | unit | provider contract, envelope shape, cleanup | `bun test tests/agent-provider.test.ts` |
| 27–28 | unit | capability wiring | `bun test` |
| 29–34 | integration | demo run end-to-end (offline + live NATS) | `bun examples/soc-triage/run-demo.ts` |
| 35 | regression | full suite | `bun test` |
| 36 | inspection | docs exist and accurate | Read |

## Features

| name | satisfies | depends_on | parallelizable |
|---|---|---|---|
| agent types + capability slot | ISC-1..10, 27..28 | — | no (foundation) |
| agent step in step-runner | ISC-11..18 | types | no |
| MockAgentProvider | ISC-19 | types | yes |
| MyelinAgentProvider | ISC-20..26 | types | yes |
| soc-triage example + demo | ISC-29..34 | step + mock provider | no |
| docs + ADR annotation | ISC-36 | all | yes |

## Decisions

- 2026-06-09: Both surfaces (capability + primitive), one provider — ApertureOscillation synthesis: capability is substrate for programmatic dispatch inside actions; `agent:` step is the declarative surface miner D/A/H and marketplace need. D=action, A=agent, H=gate.
- 2026-06-09: Provider receives AbortSignal only; runner owns timer — direct reuse of P-304 GateProvider lesson (Holly cycle-1).
- 2026-06-09: ADR 0001's deferral condition is met — "until pulse actions actually exchange Myelin envelopes" is now. Envelope-first integration proceeds; transport convergence still deferred.
- 2026-06-09: Demo is mock-first, live-optional — presentation must not depend on a running fleet.
- 2026-06-09: refined: ISC-27 — agent capability wired in `action-runner.ts` from `options.agentProvider`, not in `capabilities.ts`: the provider is host-configured, not environment-derived; `createLocalCapabilities` builds env-derived capabilities only.
- 2026-06-09: refined: ISC-30 probe — dedicated unit test replaced by end-to-end demo probe (sanitize step runs against seeded fixture; frontier agent receives PII-free IOCs, visible in demo output).
- 2026-06-09: refined: ISC-36 — ADR 0001 file itself not annotated: `docs/adr/` exists only as another session's uncommitted WIP on main; supersession note recorded in `docs/agent-actions.md` instead.
- 2026-06-09: Envelope grammar vendored (minimal builder in `agent-provider.ts`), not imported from `@the-metafactory/myelin` git dep — same approach cortex took (vendored schema); avoids dependency churn while myelin lower layers evolve. Revisit when myelin publishes to a registry.
- 2026-06-09: `nats` as optional dynamic import, not a dependency — preserves pulse's zero-runtime-dep constraint; `bun add nats` only needed for `--live`.
- 2026-06-09: show-your-math (delegation floor): 2 Explore agents at OBSERVE met the E3 floor; BUILD was sequential single-file surgery where further delegation would add coordination noise, not speed.

## Changelog

- conjectured: agent dispatch needs its own transport layer in pulse (P-500 prerequisite).
  refuted_by: myelin already ships the complete task-routing surface (F-021 subjects, dispatch lifecycle, sovereignty); cortex already consumes it.
  learned: pulse's integration is a *requester-side provider*, not infrastructure — one capability + one primitive + ~300 lines.
  criterion_now: ISC-20..26 (provider speaks myelin's existing contract verbatim).

## Verification

- ISC-1..10: typecheck — `tsc --noEmit` clean; exports confirmed in `src/index.ts`
- ISC-11..18: `bun test tests/agent-step.test.ts` — 19 pass (template rendering, collect, sovereignty forwarding, fail-fast, StepFailure, timeout+event, retry composition, lifecycle events, stepRecords, validation)
- ISC-19..26: `bun test tests/agent-provider.test.ts` — 15 pass (subject grammar, DID encoding, envelope round-trip, completed/failed lifecycle, foreign-traffic isolation, abort cleanup `subscriptionCount === 0`, post-dispatch cleanup)
- ISC-25: `grep -n "fetch\|spawn" src/lib/agent-provider.ts` → 0 matches
- ISC-29..31, 33..34: `bun examples/soc-triage/run-demo.ts --auto-approve` → pipeline ✅ success, steps `agent:triage ✓ → A_SANITIZE_IOCS ✓ → agent:enrich ✓ → gate:analyst-approval ✓ → A_PUBLISH_ADVISORY ✓`; `--violate` → frontier agent REFUSED with sovereignty-violation error
- ISC-32: live probe — nats-server up on localhost:4222; `run-demo.ts --live --auto-approve` → pipeline ✅ success (9ms) over the real bus
- ISC-35: `bun test` → 188 pass, 0 fail
- ISC-36: `docs/agent-actions.md` + CLAUDE.md "7 composition primitives" + "Agent actions (D/A/H complete)" section — Read-verified
- Shipped: branch `feat/p-600-agent-actions`, PR #15 (https://github.com/the-metafactory/pulse/pull/15)
