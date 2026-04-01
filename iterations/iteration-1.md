# Iteration 1: Execution Core

**Status:** Complete
**Scope:** Tree-based dependency graph runner — the scheduling and execution foundation.

---

## Features

### P-100: Dependency graph parser and validator
- [x] Zod schema for tree definitions (PulseTreeDefSchema)
- [x] Structural validation: min 1 node, valid retries (0-10), min timeout (100ms)
- [x] Semantic validation: cycle detection (DFS), missing dependency checks, duplicate ID detection
- [x] Parse → Validate → Hydrate pipeline

### P-101: Topological scheduler
- [x] Track node statuses: pending → running → done/failed/skipped
- [x] `getReady()` returns nodes with all dependencies satisfied
- [x] Cascade skip: failed node marks all descendants as skipped
- [x] `isComplete()` checks all nodes in terminal state

### P-102: Node executor with retry and timeout
- [x] Configurable retries per node (0-10 attempts)
- [x] Timeout enforcement via Promise.race
- [x] Proper timer cleanup (no leaks)
- [x] Attempt tracking and error propagation

### P-103: PulseRunner orchestrator
- [x] Main execution loop: schedule → execute ready → advance
- [x] Parallel sibling execution via Promise.all
- [x] Event emission: node-start, node-complete, node-failed, tree-complete
- [x] Default retries/timeout options with per-node override
- [x] Parent result passing via ExecutionContext

### P-104: CLI skeleton
- [x] `pulse validate <file>` — validate tree JSON
- [x] `pulse run <file>` — execute (requires programmatic function registration)
- [x] `pulse status` — show last execution

---

## Execution Order

```
P-100 (parser + validator)
  └─► P-101 (scheduler)
        └─► P-102 (executor)      — can parallel with P-101
              └─► P-103 (runner)   — needs both P-101 + P-102
                    └─► P-104 (CLI)
```

## Exit Criteria

- [x] 45 tests pass across 5 test files
- [x] tsc --noEmit clean
- [x] Linear, parallel, and mixed dependency trees execute correctly
- [x] Failed nodes cascade skip to dependents
- [x] Events emitted in correct sequence
