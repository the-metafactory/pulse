## Implementation Workflow

Pulse uses P-series feature numbering tracked via `blueprint.yaml` and iteration plans.

**Feature IDs (from blueprint.yaml):**
- **Iteration 1 — Execution Core:** P-100 (parser/validator), P-101 (scheduler), P-102 (executor), P-103 (PulseRunner), P-104 (CLI)
- **Iteration 2 — Pipe Model & Action Contract:** P-200 (Action contract), P-201 (passthrough pipe), P-202 (Pipeline primitive), P-203 (miner process import), P-205 (local/cloud dispatch), P-206 (pipeline YAML loader)
- **Iteration 3 — Flow & Ecosystem:** P-300 (Flow primitive), P-301 (D/A/H classification), P-302 (trace emission), P-303 (Arc package integration)
- **Iteration 4 — Runtime & Distribution:** P-400 (runtime adapters), P-401 (Cortex event bridge), P-402 (metafactory process runner)

**Workflow:**
```
1. Read the design spec (design/) and iteration plan (iterations/)
2. Pick next feature by dependency order from blueprint.yaml
3. Create feature branch: feat/p-{id}-{slug}
4. Implement against acceptance criteria in the iteration plan
5. PR → review → merge to main
6. Tick checkboxes in BOTH the iteration plan AND the GitHub tracking issue
```

**Commit conventions:** `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`

**Iteration plans:**
- `iterations/iteration-1.md` — Execution Core (complete)
- `iterations/iteration-2.md` — Pipe Model & Action Contract
- `iterations/iteration-3.md` — Flow Orchestration & Ecosystem Integration

**Design specs:**
- `design/cue-architecture.md` — Cue system (standalone artifacts, three-artifact model)

**Sync rule:** Iteration plans exist in two places — `iterations/` (repo artifact, agents read it) and a GitHub Issue (trackable, commentable). When a checkbox is completed, update both.
