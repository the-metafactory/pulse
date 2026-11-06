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
- Every prompt a run sends to a model starts with today's and yesterday's date, read once when the run starts, in `StepRunnerOptions.timeZone` or the host's zone, since an agent step sees nothing but its prompt. The routine composer sends back a flow holding a calendar date when its request names none (`src/lib/composer/frozen-dates.ts`).
- The routine composer also sends back a flow that would lose its data or invent an answer: a step's output that no later step reads, or a free-text agent step that runs after the flow has data and reads none of it (`src/lib/composer/reads-data.ts`). It sends back a flow that leaves an action's `limit` unset too, because a small default would then decide how much the routine sees. A composed flow can fix such a value in its top-level `input:` map. The check reads a flow's steps, not its request, so a flow that omits the fetch altogether and writes from the request alone still passes, as does an agent step that writes before the fetch while a later step reads the data.
- Omitted `collect` defaults to `agent_${name}` (collision-safe, gate precedent).
- `returns: string|url|number|integer|boolean|array|object` declares the one value the step yields. The step asks the model for only that value, reads it as that type (`"15"` becomes `15`, JSON text becomes the array or object), and fails naming the collect field when the answer is anything else, so the next step never sees it. Without `returns` the answer is collected as it came. The routine composer requires `returns` on any agent step whose collect field is a later action input declared as one of those types (`src/lib/composer/typed-inputs.ts`); an input declared with any other type is not checked. `returns: string` asks for only the value but cannot tell a sentence from a value, so it does not catch prose in a plain text input. A stored flow without it runs as before.
- Lifecycle events `agent.dispatched|completed|failed|timeout` flow through
  `StepRunnerOptions.onAgentEvent`.

## What goes on the bus (MyelinAgentProvider)

Vendored from the myelin v3 spec (`schemas/envelope.schema.json`,
`specs/namespace.md`, F-021 task routing) — pulse never invents grammar:

1. Build envelope: `type: tasks.{capability}`, `correlation_id = task_id`,
   full sovereignty block, payload `{task_id, capability, prompt, input?}`,
   `requirements: [capability]` when the capability is a single-segment tag
   (RFC-0003 §3.12 refuses a dotted id; the subject and payload carry it),
   `distribution_mode`, optional `deadline`.
2. Subscribe `local.{principal}.{stack}.dispatch.task.*` **before** publishing
   (no completion window lost).
3. Publish to the task subject:
   - offer: `local.{principal}.{stack}.tasks.{capability}`
   - direct/delegate: `local.{principal}.{stack}.tasks.@{encoded-did}.{capability}`
4. Resolve on the first `dispatch.task.completed|failed` whose
   `correlation_id` matches; always unsubscribe. A local task that no worker
   starts (`dispatch.task.started`) within `claimTimeoutMs` (default 120 s)
   resolves as failed with "nobody took this task", rather than waiting forever.

A Cortex exec-brain consumer speaks this contract, including `started` before it
runs, from the Cortex release that preserves an inbound `correlation_id`
(RFC-0007 §8). Cortex's review consumer answers on the request envelope's `id`
instead, so a `code-review` task from this provider ends in "nobody took this task".

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

> **The NATS subject ACLs are the actual confidentiality boundary.** The
> sovereignty block is *policy that the fleet honors* — it is not encryption.
> Payloads travel as plaintext JSON on the bus. A deployment carrying
> confidential data MUST configure NATS account/subject permissions so that
> only authorized consumers can subscribe to `local.{principal}.{stack}.tasks.>`
> (and the dispatch lifecycle). Without subject ACLs, `model_class: local-only`
> is policy theater — any bus client could read the very data the block exists
> to protect. Envelope signing (ed25519, myelin L4) is out of scope for v1 on a
> trusted local bus and becomes mandatory before federation.

## Transports

- `InMemoryAgentTransport` — NATS-semantics pub/sub in-process. Tests and
  offline demos run the *identical* envelope path; only the wire differs.
- `NatsAgentTransport` — dynamic `import("nats")`; the package is an optional
  dependency (`bun add nats`), keeping pulse core zero-dep. For a server in
  operator mode, pass `credentials` (a `.creds` file path) or set
  `PULSE_NATS_CREDS`; the option wins. Neither set → anonymous connect. A path
  that is set but unreadable throws rather than falling back to anonymous.

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
