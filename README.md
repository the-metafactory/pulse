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
| [grove](../grove/) | Event relay & multi-agent collaboration bridge |
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
    const { content, ...upstream } = input;
    const result = await ctx.capabilities.llm!(content, {
      system: "Summarize in 2-3 sentences.",
      tier: "fast",
    });
    return { ...upstream, summary: result.text };
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

## Roadmap

### Done (v0.1.0)
- Tree runner with dependency scheduling, parallel execution, retry/timeout
- Action system with capability injection (local + cloud dispatch)
- Pipeline primitive with passthrough pipe model
- 68 tests across 8 files, tsc clean

### Next
- Flow primitive (source → pipeline → destination + schedule)
- D/A/H step classification (from miner's trace types)
- JSONL trace emission (feeding back to miner)
- Arc package integration (load installed packages as actions)

See [blueprint.yaml](./blueprint.yaml) for the full feature roadmap with cross-repo dependencies.

## Development

```bash
bun install
bun test           # 68 tests across 8 files
bun run typecheck  # tsc --noEmit
```

## License

Private — part of the metafactory ecosystem.
