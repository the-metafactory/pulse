# Pulse — Process Execution Engine

Part of the [metafactory](../meta-factory/) ecosystem.

## What is Pulse?

Pulse is the execution engine that animates processes in the metafactory ecosystem. It provides two complementary execution models:

1. **Tree Runner** — dependency graph execution with parallel scheduling, retry, timeout
2. **Action System** — capability-injected actions with the passthrough pipe model, running locally (Bun) or on Cloudflare Workers

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
- **Test:** `bun test` (68 tests across 8 files)
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
    pipeline.ts       # runPipeline() — chain actions with pipe model
    capabilities.ts   # Local/cloud capability providers
  types/
    pulse.ts          # Tree runner interfaces
    action.ts         # Action system interfaces (inspired by PAI)
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

## Key commands

```bash
bun test              # Run all 68 tests
bun run typecheck     # TypeScript check
bun src/cli.ts validate examples/simple-tree.json
```

## Working conventions

- Tree runner tests in `tests/` mirroring `src/lib/`
- Action/pipeline tests create temp action dirs in `beforeAll`, clean up in `afterAll`
- All tree types in `src/types/pulse.ts`, action types in `src/types/action.ts`
- No external runtime dependencies beyond commander + zod
