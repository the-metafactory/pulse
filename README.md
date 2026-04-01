# Pulse

**Process execution engine for the metafactory ecosystem.**

Pulse takes dependency trees of actions and executes them with parallel scheduling, retry logic, timeout enforcement, and real-time event emission. It's the heartbeat that animates composed processes — the runtime that turns captured workflows back into living work.

## Origin & naming

Pulse was originally prototyped as "Arbol" (Spanish for "tree"), inspired by Daniel Miessler's [PAI](https://github.com/danielmiessler/PAI) project where Arbol describes a cloud execution platform built on three composable primitives: Actions, Pipelines, and Flows.

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

The name reflects what it does: **a pulse propagates through the system, each action is a beat, a pipeline is a pulse, and scheduled flows create a rhythm.** It's what separates a living process from a dead document.

## Ecosystem context

| Project | Role |
|---------|------|
| [metafactory](../meta-factory/) | Trusted marketplace for agentic components |
| [arc](../arc/) | Package manager — installs skills, tools, agents, processes |
| [grove](../grove/) | Event relay & multi-agent collaboration bridge |
| [miner](../miner/) | Process mining — captures traces, extracts patterns |
| [blueprint](../blueprint/) | Cross-repo dependency tracking |
| **pulse** | **Process execution engine** |

## Current capabilities (v0.1.0)

What we have today is the **tree runner** — the scheduling and execution core:

- **Dependency-graph execution** — nodes declare `dependsOn` edges, pulse resolves the topological order
- **Parallel sibling execution** — independent nodes run concurrently via `Promise.all`
- **Retry logic** — configurable per-node retries (0-10 attempts)
- **Timeout enforcement** — per-node timeouts via `Promise.race` with proper timer cleanup
- **Cascade failure** — when a node exhausts retries, all descendants are skipped
- **Event system** — `node-start`, `node-complete`, `node-failed`, `tree-complete` events
- **Validation** — cycle detection (DFS), missing dependency checks, duplicate ID detection
- **Zod schema validation** — structural validation of tree definitions

## Usage

```typescript
import { PulseRunner } from "pulse";

const runner = new PulseRunner({ defaultRetries: 2 });

runner.registerAll({
  fetch: async () => ({ data: [1, 2, 3] }),
  process: async (ctx) => transform(ctx.parentResults.get("fetch")),
  save: async (ctx) => persist(ctx.parentResults.get("process")),
});

const execution = await runner.run({
  id: "my-pipeline",
  nodes: [
    { id: "fetch", name: "Fetch Data" },
    { id: "process", name: "Process", dependsOn: ["fetch"] },
    { id: "save", name: "Save", dependsOn: ["process"] },
  ],
});

console.log(execution.status); // "completed" | "failed"
```

## Roadmap — toward the full vision

The PAI Arbol vision describes three composable primitives. Pulse currently implements the execution core; the full vision requires:

### 1. Pipe model (next)

The PAI passthrough pattern where data accumulates through a pipeline:

```typescript
// Each action preserves upstream data and adds its own
return { ...upstream, myField: result };
```

Currently our `ExecutionContext` passes parent results as a Map. The pipe model would make this implicit — each action receives everything from all ancestors, not just direct parents.

### 2. Pipeline primitive

A first-class `Pipeline` that chains Actions linearly with the pipe model. Declarative definition (YAML or JSON):

```yaml
name: P_LABEL_EMAIL
actions:
  - A_EXTRACT
  - A_LABEL
  - A_SEND_EMAIL
```

### 3. Flow primitive

Top-level orchestrator: source + pipeline + destination + schedule.

```yaml
name: F_RSS_DIGEST
source: rss://feeds.example.com
pipeline: P_LABEL_EMAIL
schedule: "0 */6 * * *"
destination: email://digest@example.com
```

### 4. D/A/H step classification

Miner classifies process steps as Deterministic / Agentic / Human-gate. Pulse should respect these:
- **D** steps: execute automatically
- **A** steps: delegate to an agent
- **H** steps: pause for human approval

### 5. Trace emission

Every execution should produce JSONL traces that miner can re-ingest, closing the feedback loop.

## Development

```bash
bun install
bun test           # 45 tests across 5 files
bun run typecheck  # tsc --noEmit
```

## License

Private — part of the metafactory ecosystem.
