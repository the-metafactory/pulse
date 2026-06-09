# Agent Actions — LLM/agent tasks as first-class Pulse steps

> P-600 (myelin envelope integration) + P-601 (job publishing to NATS) + the
> "delegate A" half of P-301 (D/A/H classification).

## The idea in one line

Pulse doesn't learn how to run agents — it learns how to **ask the bus**. The
fleet (cortex agents), routing (myelin task subjects), and policy enforcement
(sovereignty blocks) already exist; pulse's whole integration is one capability,
one step keyword, and one provider.

## D/A/H, literal

Miner classifies process steps as **D**eterministic / **A**gentic / **H**uman.
With this feature the taxonomy maps 1:1 onto pulse's step vocabulary:

| Class | Pipeline YAML | Executed by |
|-------|---------------|-------------|
| **D** | `- A_SOME_ACTION` | pulse, locally (pure transform, capability injection) |
| **A** | `- agent:` | the fleet — task envelope on the bus, any agent that claims it |
| **H** | `- gate:` | a human — pause for operator verdict |

## Two surfaces, one provider

```
                    ┌──────────────────────┐
  action.ts ──────► │ ctx.capabilities     │      (programmatic dispatch
  requires:["agent"]│   .agent(taskSpec)   │       inside custom actions)
                    └──────────┬───────────┘
                               │
  pipeline.yaml ──► ┌──────────▼───────────┐
  - agent:          │   AgentProvider      │      dispatch(spec, {signal})
      capability: … │  (pluggable, like    │      → Promise<AgentTaskResult>
      sovereignty: …│   GateProvider)      │
                    └──────────┬───────────┘
                  ┌────────────┴─────────────┐
        ┌─────────▼────────┐      ┌──────────▼─────────┐
        │ MockAgentProvider│      │ MyelinAgentProvider│
        │ (tests, fallback)│      │ (the real thing)   │
        └──────────────────┘      └──────────┬─────────┘
                                  ┌──────────▼─────────┐
                                  │   AgentTransport   │  InMemory | NATS
                                  └────────────────────┘
```

- **Capability surface** — actions declare `requires: ["agent"]` and receive
  `ctx.capabilities.agent(taskSpec)`. For programmatic dispatch: loops,
  conditional routing, fan-out from inside an action.
- **Step surface** — the declarative `agent:` keyword in pipeline YAML. This is
  what miner's A-classification compiles to and what marketplace processes use.

Both run through `StepRunnerOptions.agentProvider` / `ActionRunnerOptions.agentProvider`.
There is **no default provider** — a pipeline containing agent steps without a
configured provider fails fast (unlike `gate`, which defaults to stdin).

## The contract (mirrors GateProvider — P-304 precedent)

```typescript
interface AgentProvider {
  dispatch(spec: AgentTaskSpec, opts?: { signal?: AbortSignal }): Promise<AgentTaskResult>;
}
```

- The **runner owns the timeout** — providers receive only an `AbortSignal` and
  MUST reject when it fires.
- `dispatch()` resolves with `status: "completed" | "failed"`; it rejects only
  on transport errors and aborts. The step runner raises `StepFailure` on
  `failed`, so `retry:` can wrap agent steps.
- Omitted `collect` defaults to `agent_${name}` (collision-safe, gate precedent).
- Lifecycle events `agent.dispatched|completed|failed|timeout` flow through
  `StepRunnerOptions.onAgentEvent`.

## What goes on the bus (MyelinAgentProvider)

Vendored from the myelin v3 spec (`schemas/envelope.schema.json`,
`specs/namespace.md`, F-021 task routing) — pulse never invents grammar:

1. Build envelope: `type: tasks.{capability}`, `correlation_id = task_id`,
   full sovereignty block, payload `{task_id, capability, prompt, input?}`,
   `requirements: [capability]`, `distribution_mode`, optional `deadline`.
2. Subscribe `local.{principal}.{stack}.dispatch.task.*` **before** publishing
   (no completion window lost).
3. Publish to the task subject:
   - offer: `local.{principal}.{stack}.tasks.{capability}`
   - direct/delegate: `local.{principal}.{stack}.tasks.@{encoded-did}.{capability}`
4. Resolve on the first `dispatch.task.completed|failed` whose
   `correlation_id` matches; always unsubscribe.

This is exactly the contract cortex's dispatch listener and lifecycle publisher
already speak — a cortex fleet can claim pulse tasks with no pulse changes.

## Sovereignty routing

The envelope's sovereignty block is the confidential-data story:

```yaml
- agent:
    name: triage
    capability: soc.triage.email
    prompt: "Analyze: {email_raw}"        # raw member data
    sovereignty:
      model_class: local-only             # ONLY a local model may execute
      frontier_ok: false
      data_residency: CH
```

The policy travels **with the task**; enforcement happens at the consumer (and,
on a federated bus, at the replication boundary — myelin L2). Pulse declares,
the bus enforces. See `examples/soc-triage/` for the full
local→sanitize→frontier→human pattern, including the refusal path (`--violate`).

## Transports

- `InMemoryAgentTransport` — NATS-semantics pub/sub in-process. Tests and
  offline demos run the *identical* envelope path; only the wire differs.
- `NatsAgentTransport` — dynamic `import("nats")`; the package is an optional
  dependency (`bun add nats`), keeping pulse core zero-dep.

## Out of scope (v1)

Bidding (F-10) — offer/direct only. Envelope signing (ed25519) — lands with
federation. Streaming progress into payload. Cloud-mode agent capability.

## Decisions

- Both surfaces, one provider (ApertureOscillation synthesis: capability =
  substrate, step = declarative surface for miner/marketplace).
- Signal-only abort, runner-owned timer (Holly's P-304 cycle-1 lesson, reused).
- ADR 0001's deferral condition ("until pulse actions actually exchange Myelin
  envelopes") is met by this feature — envelope-first integration is now
  active; transport-layer convergence remains deferred.
