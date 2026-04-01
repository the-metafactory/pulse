# Pulse — Process Execution Engine

Part of the [metafactory](../meta-factory/) ecosystem.

## What is Pulse?

Pulse is the execution engine that animates processes in the metafactory ecosystem. It takes composed process definitions — dependency trees of actions — and runs them with parallel scheduling, retry logic, timeout enforcement, and event emission.

## Where it fits

```
miner captures traces → metafactory distributes → arc installs → pulse executes
                                                                    ↓
                                                    traces feed back to miner
```

## Tech stack

- **Runtime:** Bun
- **Language:** TypeScript (strict)
- **Test:** `bun test` (45 tests across 5 files)
- **Dependencies:** commander, zod

## Architecture

```
src/
  lib/
    runner.ts      # PulseRunner — main orchestrator (EventEmitter)
    parser.ts      # TreeParser — schema + semantic validation
    scheduler.ts   # Scheduler — dependency tracking, parallel readiness
    executor.ts    # Executor — retry/timeout per node
    cycles.ts      # DFS cycle detection
  types/pulse.ts   # All interfaces
  schemas/tree.ts  # Zod schemas
  commands/        # CLI commands (run, validate, status)
  cli.ts           # CLI entry point
  index.ts         # Public API exports
```

## Key commands

```bash
bun test              # Run all tests
bun run typecheck     # TypeScript check
bun src/cli.ts validate examples/simple-tree.json
```

## Working conventions

- Tests live in `tests/` mirroring `src/lib/`
- All types in `src/types/pulse.ts`
- Zod schemas in `src/schemas/tree.ts`
- No external runtime dependencies beyond commander + zod
