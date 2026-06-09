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

## 2026-04-27 - P-304 Interactive gate as primitive (not action)
- Decision: Model `gate` as a pipeline composition primitive (alongside map/filter/reduce/parallel/retry), not as a special action type.
- Rationale: Gates are control-flow (pause + side-channel input + verdict-driven halt), not pure transforms. The action contract (input → output, capability injection) doesn't fit; the primitive contract does. Holly endorsed this on review.
- Side effect: Gate is now the only LEAF primitive (no nested `actions`). Sets precedent for future control-flow leaves (sleep, wait-for-event, manual-checkpoint).
- Alternatives rejected: A built-in action `A_GATE` with a special `gate` capability — would have forced a pure-function shape onto a fundamentally pause-and-collect operation.

## 2026-04-27 - P-304 GateProvider: signal-only (not timeout_ms + signal)
- Decision: `GateProvider.requestVerdict(spec)` receives only an AbortSignal; the runner owns the timer. Providers MUST reject when the signal fires.
- Rationale: Original interface had both `timeout_ms` AND `signal`. Holly cycle-1 caught the inconsistency — `StdinGateProvider` ignored `timeout_ms` entirely. Custom providers honoring `timeout_ms` instead of `signal` would silently bypass the runner's abort wiring.
- Alternatives rejected: Provider-owned timeout (would split the abort path into two contracts).

## 2026-04-27 - P-304 Default `collect` derives from name
- Decision: When `collect` is omitted on a gate, the result is written to upstream context under `gate_${name}`, not a fixed `gate` field.
- Rationale: Two gates in one pipeline with default collect would silently overwrite each other's results. Deriving from name prevents collision; name is already required for events/traces.
- Trade-off: Hyphenated names produce object keys requiring bracket access (`result["gate_release-gate"]`). Documented; not yet validated at parse time. Tracked in #11.

## 2026-05-30 - Domain language (CONTEXT.md) created via grill-with-docs
- Decision: Established pulse's ubiquitous language in CONTEXT.md (glossary, relationships, flagged ambiguities).
- Key resolutions:
  - Process = ecosystem/registry term (packaged, installable unit); Pipeline/Flow/Tree = internal runtime shapes it resolves to. Tagline "Process Execution Engine" honest without Process being a 5th primitive.
  - Pipeline/Flow/Tree distinguished by PURPOSE not topology: Pipeline=data-passthrough authoring, Tree=dependency orchestration, Flow=deployment (source+dest+schedule). Pipeline/Tree topologically overlap; kept both deliberately.
  - Step = umbrella (Action | Primitive). Primitive = Composition (map/filter/reduce/parallel/retry, wraps sub-pipeline) | Control (gate, leaf). Actions authored+require capabilities; Primitives built-in+runner-owned.
  - Payload = flowing data (renamed `upstream`→`payload` across 167 sites, branchUpstream→branchPayload; 154 tests pass). Context = injected services (ActionContext). Never share the word.
  - cue.fired = inbound event pulse subscribes to. "trigger" banned as noun. Cue/Binding = FOREIGN (metafactory-owned); pulse never evaluates/resolves them.
  - Trace = FOREIGN (miner owns schema); pulse emits. Span context stays out of glossary as generic.
  - Engine = pulse whole; Tree Runner = component (class PulseRunner, historical name, runs Trees only). Scheduler/Executor = impl, not language.
  - Capability vocab: requirement (manifest) vs implementation (injected) vs injection (mechanism); Mode = local|cloud; Capability provider = per-mode source.
  - Envelope + Sovereignty = FOREIGN (myelin L3); pulse integration is FUTURE (myelin postdates pulse).
- Open: "runtime adapter" (P-400) not added to glossary (undecided). Transport ownership UNRESOLVED → ADR 0001.
- Rationale: pulse had rich implicit vocabulary in code+CLAUDE.md with real overloads (Process, Context, Trace, trigger); glossary makes boundaries explicit, esp. foreign terms from metafactory/miner/myelin.

## 2026-05-30 - ADR 0001: Transport ownership (deferred myelin convergence)
- Decision: Pulse keeps own transport abstraction (packages/transport/); does NOT converge on myelin L2 now. Myelin integration is envelope-first/incremental; transport convergence deferred until pulse actions actually exchange Myelin envelopes.
- Rationale: myelin postdates pulse, lower layers still evolving; coupling now imports churn for no present benefit. Envelope = smaller, higher-value, lower-risk first integration surface.
- Alternatives rejected: (a) myelin owns transport now, pulse depends — premature given myelin churn; (b) ignore the conflict — leaves two unexplained transport layers.
- File: docs/adr/0001-transport-ownership.md

## 2026-06-09 - P-600/P-601 Agent actions: two surfaces, one provider
- Decision: Agent dispatch shipped as BOTH an injected `agent` capability (programmatic, inside actions) AND an `agent:` step primitive (declarative YAML) — backed by one pluggable `AgentProvider` (signal-only abort, runner owns timer, gate precedent).
- Rationale: Miner D/A/H needs a declarative compile target (D=action, A=agent:, H=gate:); custom actions need programmatic dispatch. One provider serves both.
- Alternatives rejected: capability-only (kills declarative/marketplace story); primitive-only (no programmatic fan-out inside actions).

## 2026-06-09 - MyelinAgentProvider: vendored envelope builder + optional nats dep
- Decision: Vendor minimal myelin v3 envelope builder + subject grammar in `src/lib/agent-provider.ts`; `nats` is a dynamic-import optional dep (`bun add nats` for --live). AgentTransport seam: InMemoryAgentTransport (tests/demos, identical envelope path) + NatsAgentTransport.
- Rationale: same approach cortex took (vendored schema); preserves zero-runtime-dep constraint; ADR 0001 envelope-first condition now met (noted in docs/agent-actions.md — ADR file itself is another session's uncommitted WIP, untouched).
- Shipped: PR #15, branch feat/p-600-agent-actions, worktree ../pulse-agent-actions. 188 tests. Demo: examples/soc-triage (offline mock-first, --live probed against real NATS on 4222, --violate shows sovereignty refusal).
