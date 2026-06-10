# Pulse

**Process execution engine for the metafactory ecosystem.**

Pulse takes dependency trees of actions and executes them with parallel scheduling, retry logic, timeout enforcement, and real-time event emission. It's the heartbeat that animates composed processes — the runtime that turns captured workflows back into living work.

## Origin & credits

Pulse was originally prototyped as "Arbol" (Spanish for "tree"), inspired by Daniel Miessler's [PAI](https://github.com/danielmiessler/PAI) project where Arbol describes a cloud execution platform built on three composable primitives: Actions, Pipelines, and Flows.

The **action system** (capability injection, local/cloud dispatch, passthrough pipe model) is directly adapted from PAI's Actions framework — specifically the `runner.v2.ts` and `types.v2.ts` patterns that Daniel designed. The core insight: **actions declare what capabilities they need, the runtime provides implementations.** Same action code runs on Bun locally or on Cloudflare Workers. We extracted and generalized this pattern into pulse as the execution engine for the broader metafactory ecosystem.

We renamed it **Pulse** when moving it into the metafactory ecosystem, where it completes the lifecycle:

```
Work happens
  → miner observes and captures traces
    → miner extracts process patterns
      → metafactory distributes them
        → arc installs them locally
          → pulse executes them        ← the heartbeat
            → execution traces feed back to miner
```

The name reflects what it does: **a pulse propagates through the system, each action is a beat, a pipeline is a pulse, and scheduled flows create a rhythm.**

## Ecosystem context

| Project | Role |
|---------|------|
| [metafactory](../meta-factory/) | Trusted marketplace for agentic components |
| [arc](../arc/) | Package manager — installs skills, tools, agents, processes |
| [cortex](../cortex/) | Agent fleet runtime — bus dispatch, Mission Control, surface adapters |
| [miner](../miner/) | Process mining — captures traces, extracts patterns |
| [blueprint](../blueprint/) | Cross-repo dependency tracking |
| **pulse** | **Process execution engine** |

## Two execution models

Pulse provides two complementary ways to run work:

### 1. Tree Runner — dependency graph execution

For complex workflows with non-linear dependencies:

```typescript
import { PulseRunner } from "pulse";

const runner = new PulseRunner({ defaultRetries: 2 });

runner.registerAll({
  fetch: async () => ({ data: [1, 2, 3] }),
  process: async (ctx) => transform(ctx.parentResults.get("fetch")),
  save: async (ctx) => persist(ctx.parentResults.get("process")),
});

const execution = await runner.run({
  id: "my-tree",
  nodes: [
    { id: "fetch", name: "Fetch Data" },
    { id: "process", name: "Process", dependsOn: ["fetch"] },
    { id: "save", name: "Save", dependsOn: ["process"] },
  ],
});
```

Features: parallel sibling execution, retry/timeout per node, cycle detection, cascade failure, event emission, Zod validation.

### 2. Action System — capability-injected actions with pipe model

For composable, portable actions that run locally or in the cloud:

**Define an action** (`A_SUMMARIZE/action.json`):
```json
{
  "name": "A_SUMMARIZE",
  "version": "1.0.0",
  "description": "Summarize text using LLM",
  "input": { "content": { "type": "string", "required": true } },
  "output": { "summary": { "type": "string" } },
  "requires": ["llm"]
}
```

**Implement it** (`A_SUMMARIZE/action.ts`):
```typescript
export default {
  async execute(input, ctx) {
    const { content, ...payload } = input;
    const result = await ctx.capabilities.llm!(content, {
      system: "Summarize in 2-3 sentences.",
      tier: "fast",
    });
    return { ...payload, summary: result.text };
  },
};
```

**Run it** — locally or in the cloud:
```typescript
import { runAction } from "pulse";

// Local execution (Bun)
const result = await runAction("A_SUMMARIZE", { content: "..." }, {
  actionDirs: ["./actions"],
  mode: "local",
});

// Cloud execution (Cloudflare Worker)
const result = await runAction("A_SUMMARIZE", { content: "..." }, {
  actionDirs: ["./actions"],
  mode: "cloud",
  cloudUrlPattern: "https://pulse-{name}.workers.dev",
});
```

**Chain into a pipeline** — data accumulates through the passthrough pattern:
```typescript
import { runPipeline } from "pulse";

const result = await runPipeline(
  { name: "P_DIGEST", actions: ["A_EXTRACT", "A_SUMMARIZE", "A_FORMAT"] },
  { url: "https://example.com/article" },
  { actionDirs: ["./actions"] }
);
// result.output has ALL fields from ALL actions
```

**Compose with primitives** — pipelines support 8 composition primitives that let you process collections, fan out to parallel branches, wrap steps with retry policies, pause for operator input, dispatch an agent task to the fleet, or convene a model-diverse verdict panel. Actions stay pure — they never know composition is happening.

| Primitive | Purpose | Key options |
|-----------|---------|-------------|
| `map` | Apply a sub-pipeline to each item in a collection | `concurrency`, `onError: stop\|skip\|collect` |
| `filter` | Keep items where a sub-pipeline predicate returns true | `keep_field`, `concurrency` |
| `reduce` | Sequentially fold items into an accumulator | `init`, `item_as`, `acc_as` |
| `parallel` | Run named branches concurrently, merge outputs | `onError: stop\|collect`, AbortController cancellation |
| `retry` | Wrap a sub-pipeline with retry + backoff policy | `attempts`, `backoff`, `on` (error types) |
| `gate` | Pause for operator verdict (interactive H-step) | `name`, `prompt`, `timeout_ms?`, `collect?` |
| `agent` | Dispatch an LLM/agent task to the fleet (agentic A-step) | `capability`, `prompt`, `sovereignty?`, `timeout_ms?`, `collect?` |
| `tribunal` | Model-diverse agent panel rules allow/deny/defer on a judgment call | `seats[]`, `tiebreaker?`, `confidence_bar?`, `on_defer: fail\|continue` |

The three step kinds map onto miner's D/A/H process taxonomy: **D**eterministic = action, **A**gentic = `agent`, **H**uman = `gate`. Agent tasks travel as myelin envelopes over NATS via a pluggable `AgentProvider` — see [`docs/agent-actions.md`](docs/agent-actions.md) and [`examples/soc-triage/`](examples/soc-triage/). `tribunal` composes the A-step into governance: N model-diverse seats vote, a deterministic fail-closed aggregator rules `allow/deny/defer` — L1 of the governed-action stack between the enforcement gate (L0) and the human gate (L2). See [`docs/verdict-tribunal.md`](docs/verdict-tribunal.md) and [`examples/tribunal/`](examples/tribunal/).

**YAML example** — filter, map with retry, reduce into a report:
```yaml
name: P_LINKEDIN_PULSE_DIGEST
actions:
  - filter:
      over: posts
      as: post
      actions: [A_POST_WITHIN_WINDOW]
      keep_field: keep
      collect: recent_posts

  - map:
      over: recent_posts
      as: post
      concurrency: 1
      onError: collect
      actions:
        - retry:
            attempts: 3
            backoff: exponential
            actions: [A_LINKEDIN_POST_ENGAGEMENT]
        - A_LINKEDIN_DIGEST_DELTA
      collect: per_post_digests

  - reduce:
      over: per_post_digests
      init: { header: "# Daily Digest\n\n", body: "" }
      item_as: digest
      acc_as: report
      actions: [A_APPEND_DIGEST_MD]
      collect: final_report

  - A_FORMAT_FINAL_REPORT
```

**Interactive gates** — pause for operator verdict (used by journey-test specs):
```yaml
- A_DEPLOY_TO_STAGING
- gate:
    name: smoke-check
    prompt: "Did staging come up clean? (pass/fail + notes)"
    timeout_ms: 600000   # optional; omit for indefinite wait
    collect: smoke_decision   # optional; default: gate_${name}
- A_PROMOTE_TO_PROD
```
Inject a custom `GateProvider` (HTTP, UI, Slack, etc.) via `StepRunnerOptions.gateProvider`; the default `StdinGateProvider` reads pass/fail + notes from stdin. The result (`{ name, verdict, notes, opened_at, closed_at }`) is merged into payload context under the `collect` field. `verdict: "fail"` halts the pipeline with a `StepFailure` carrying the operator's notes — there is no "fail but continue" branch yet; treat the gate as a hard stop. Lifecycle events (`gate.opened`, `gate.closed`, `gate.timeout`) are emitted via the optional `onGateEvent` hook so hosts can route them to traces; the verdict + notes are also captured on the corresponding `StepRecord` so callers without a hook still see them via `PipelineResult.steps`.

Gate, agent, and tribunal are the leaf composition primitives (no nested `actions`). The other primitives wrap sub-pipelines; the leaves are dispatch-and-collect terminals. Future control-flow primitives (sleep, wait-for-event, manual-checkpoint) will follow this same shape.

**Parallel branches** — fan out to heterogeneous work:
```yaml
- parallel:
    branches:
      calendar:
        actions: [A_FETCH_CALENDAR]
      email:
        actions: [A_FETCH_EMAIL_DIGEST]
      work:
        actions: [A_FETCH_OPEN_WORK, A_RANK_WORK]
    onError: stop
```

**Design principles:** Concurrency defaults to 1 (rate-limited APIs punish accidental parallelism). Errors stop by default (silent data loss is worse than loud failure). Primitives compose — `retry` inside `map`, `map` inside `parallel`, nesting is supported by the recursive dispatch. See `docs/iteration-primitives.md` for the full design rationale.

### 3. Flow — source, pipeline, destination, schedule

The top-level orchestrator that connects everything:

```typescript
import { runFlow, scheduleFlow } from "pulse";

// Run once: fetch RSS → process pipeline → write to file
const result = await runFlow({
  name: "F_RSS_DIGEST",
  source: { type: "rss", url: "https://example.com/feed.xml", limit: 5 },
  pipeline: "./pipelines/P_RSS_DIGEST/pipeline.yaml",
  destination: { type: "file", path: "./digest.md", format: "markdown" },
}, { actionDirs: ["./actions"] });

// Run on schedule: every 6 hours
const { stop } = scheduleFlow({
  name: "F_RSS_DIGEST",
  source: { type: "rss", url: "https://example.com/feed.xml" },
  pipeline: { actions: ["A_FETCH_FEED", "A_EXTRACT", "A_RATE", "A_RECOMMEND"] },
  destination: { type: "file", path: "./digest.md", format: "markdown" },
  schedule: { intervalSeconds: 6 * 60 * 60 },
}, {
  actionDirs: ["./actions"],
  onRun: (result) => console.log(`Flow completed: ${result.success}`),
});

// Stop later
stop();
```

Source types: `inline`, `file`, `rss`, `custom` function. Destination types: `stdout`, `file` (JSON/markdown), `webhook`, `custom` function. Each stage reports failure independently via `failedStage`.

## Capability injection

Actions declare what they need. The runtime provides it. The action never imports its own dependencies:

| Capability | Local (Bun) | Cloud (Workers) |
|---|---|---|
| `llm` | PAI Inference tool or Anthropic API | Workers AI or API |
| `fetch` | Native fetch | Worker fetch |
| `shell` | Bun.spawn | Not available |
| `readFile` | Bun.file | Not available |
| `writeFile` | Bun.write | Not available |
| `kv` | In-memory Map | KV namespace binding |

Actions that require `shell` or `readFile` can only run locally. Actions that only need `llm` and `fetch` run anywhere.

## Ecosystem Integration

Pulse completes the "capture → distribute → execute" loop. The ecosystem analogy: Miner is the brain (captures how work happens), metafactory + Arc form the distribution network, cortex is the nervous system (the bus-native agent runtime — dispatch, Mission Control, Discord/Mattermost surfaces), and Pulse provides the muscles that actually *do* things.

### Cortex event bridging

Pulse emits real-time events during execution (node-start, node-complete, node-failed, tree-complete) plus gate/agent/tribunal lifecycle events. These ride the NATS bus that cortex already runs — agent tasks and tribunal seats dispatch as myelin envelopes today, and the event bridge (P-401) extends that so cortex's Mission Control and Discord/Mattermost adapters surface execution status. An agent kicks off a Pulse pipeline, and collaborators watch it run in real time.

### Arc as the glue

Pulse loads actions from directories today. The key connector is P-303 (Arc package integration): Arc installs packages, Pulse runs them. Cortex already integrates with Arc for agent upgrades — extending that to trigger Pulse executions is the logical next step. The flow becomes: `arc install` → actions appear → `pulse run` picks them up.

### The self-improving loop

The feedback loop back to Miner (P-302 trace emission → Miner ingestion) is where the ecosystem becomes self-improving:

```
Miner captures how work happens
  → patterns get extracted
    → Pulse executes them
      → execution traces refine the patterns
```

Each cycle tightens the process definitions. Miner's D/A/H step classification (Deterministic / Agentic / Human-gate) flows into Pulse's execution model (P-301), so the system learns not just *what* to do but *how* each step should be handled.

### Portability

The capability injection pattern means the same action code runs locally on Bun or on Cloudflare Workers. This aligns with cortex's model of straddling local and cloud execution — actions that only need `llm` and `fetch` can run anywhere, while those requiring `shell` or `readFile` stay local.

## Roadmap

### Done (v0.10.0)
- Tree runner with dependency scheduling, parallel execution, retry/timeout
- Action system with capability injection (local + cloud dispatch)
- Pipeline primitive with passthrough pipe model + YAML loader
- Flow primitive: source → pipeline → destination with scheduling
- **Composition primitives: map, filter, reduce, parallel, retry, gate, agent, tribunal** — functional, control-flow, agentic, and governance composition
- **Interactive gate primitive** — operator verdict, pluggable GateProvider, lifecycle events (H-step)
- **Agent primitive** — capability-addressed fleet tasks as myelin envelopes over NATS, sovereignty constraints travel with the payload (A-step)
- **Enforcement gate (L0)** — deterministic fail-closed runtime tool-call policy (governance Stage 1)
- **Verdict tribunal (L1)** — model-diverse agent panel adjudicates the gate's `ask` decisions (governance Stage 3)
- Arc package integration (arc-installed actions, pipelines, flows)
- Step-level validation at parse time, partial output preservation, AbortController cancellation
- 287 tests across 20 files, tsc clean

### Next
- Layered governed-action pipeline (P-702): compose L0 → L1 → L2, SOC containment demo
- Cortex event bridge (P-401): execution events surfaced in Mission Control
- JSONL trace emission feeding back to miner (P-302)

See [blueprint.yaml](./blueprint.yaml) for the full feature roadmap with cross-repo dependencies.

## Development

```bash
bun install
bun test           # 287 tests across 20 files
bun run typecheck  # tsc --noEmit
```

## License

Private — part of the metafactory ecosystem.
