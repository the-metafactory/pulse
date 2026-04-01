# Pulse — Process Execution Engine

Part of the [metafactory](../meta-factory/) ecosystem. v0.2.0.

## What is Pulse?

Pulse is the execution engine that animates processes in the metafactory ecosystem. Three composable primitives:

1. **Action** — atomic unit of work with capability injection, runs locally (Bun) or on Cloudflare Workers
2. **Pipeline** — linear chain of actions with the passthrough pipe model
3. **Flow** — source → pipeline → destination, with scheduling

Plus a **Tree Runner** for non-linear dependency graph execution.

The action system is adapted from Daniel Miessler's [PAI Actions framework](https://github.com/danielmiessler/PAI).

## Where it fits

```
miner captures traces → metafactory distributes → arc installs → pulse executes
                                                                    ↓
                                                    traces feed back to miner
```

## Tech stack

- **Runtime:** Bun
- **Language:** TypeScript (strict)
- **Test:** `bun test` (91 tests across 10 files)
- **Dependencies:** commander, zod

## Architecture

```
src/
  lib/
    runner.ts         # PulseRunner — tree-based dependency graph orchestrator
    parser.ts         # TreeParser — schema + semantic validation
    scheduler.ts      # Scheduler — dependency tracking, parallel readiness
    executor.ts       # Executor — retry/timeout per node
    cycles.ts         # DFS cycle detection
    action-runner.ts  # runAction() — load and execute actions locally or cloud
    pipeline.ts       # runPipeline(), loadPipeline(), runPipelineFromYaml(), discoverPipelines()
    flow.ts           # runFlow(), scheduleFlow(), loadFlow()
    capabilities.ts   # Local/cloud capability providers
  types/
    pulse.ts          # Tree runner interfaces
    action.ts         # Action system interfaces (inspired by PAI)
    flow.ts           # Flow types (FlowDef, FlowSource, FlowDestination, FlowSchedule)
  schemas/tree.ts     # Zod schemas for tree definitions
  commands/           # CLI commands (run, validate, status)
  cli.ts              # CLI entry point
  index.ts            # Public API exports
```

## Key concepts

### Action contract
Actions are `action.json` (manifest) + `action.ts` (implementation) pairs. The manifest declares required capabilities; the runtime injects them. Same code runs locally or on Workers.

### Passthrough pattern
Actions destructure what they need, spread the rest as `upstream`:
```typescript
const { content, ...upstream } = input;
return { ...upstream, summary: result.text };
```

### Capability injection
Actions never import their dependencies. They declare `requires: ["llm", "fetch"]` and receive implementations via `ctx.capabilities`.

### Pipeline YAML
Pipelines can be defined declaratively. Actions are resolved from the directory containing the YAML:
```yaml
name: P_RSS_DIGEST
actions:
  - A_FETCH_FEED
  - A_EXTRACT_ARTICLE
  - A_RATE
  - A_RECOMMEND
```

### Flow
Flows connect source → pipeline → destination. Sources: inline, file, RSS, custom. Destinations: stdout, file, webhook, custom. Scheduling via interval or cron approximation.

## Key commands

```bash
bun test              # Run all 91 tests
bun run typecheck     # TypeScript check
bun src/cli.ts validate examples/simple-tree.json
bun examples/rss-pipeline/run-demo.ts  # Run RSS demo
```

## Working conventions

- Tree runner tests in `tests/` mirroring `src/lib/`
- Action/pipeline/flow tests create temp dirs in `beforeAll`, clean up in `afterAll`
- Tree types in `src/types/pulse.ts`, action types in `src/types/action.ts`, flow types in `src/types/flow.ts`
- No external runtime dependencies beyond commander + zod
