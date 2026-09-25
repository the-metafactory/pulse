<!-- Generated from metafactory ecosystem template. Customize sections marked with {PLACEHOLDER}. -->

# pulse -- Process Execution Engine

Process Execution Engine

## What is Pulse?

Pulse is the execution engine that animates processes in the metafactory ecosystem. Three composable primitives:

1. **Action** — atomic unit of work with capability injection, runs locally (Bun) or on Cloudflare Workers
2. **Pipeline** — chain of actions with passthrough pipe model + composition primitives (map, filter, reduce, parallel, retry, gate)
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
- **Test:** `bun test` (405 tests across 29 files)
- **Dependencies:** commander, zod, yaml

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
    step-runner.ts    # runSteps(), runStep() — iteration/composition primitive dispatcher
    flow.ts           # runFlow(), scheduleFlow(), loadFlow()
    capabilities.ts   # Local/cloud capability providers
  types/
    pulse.ts          # Tree runner interfaces
    action.ts         # Action system interfaces (inspired by PAI)
    pipeline.ts       # PipelineStep union + specs: Map, Filter, Reduce, Parallel, Retry
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
Actions destructure what they need, spread the rest as `payload`:
```typescript
const { content, ...payload } = input;
return { ...payload, summary: result.text };
```

### Capability injection
Actions never import their dependencies. They declare `requires: ["llm", "fetch"]` and receive implementations via `ctx.capabilities`.

### Pipeline YAML
Pipelines can be defined declaratively. Actions are resolved from the directory containing the YAML. Steps can be plain action names (strings) or iteration primitives (objects with a keyword):
```yaml
name: P_RSS_DIGEST
actions:
  - A_FETCH_FEED
  - A_EXTRACT_ARTICLE
  - A_RATE
  - A_RECOMMEND
```

### Composition primitives
Pipelines support 10 composition primitives that operate on collections or control execution while keeping actions pure:
- **map** — apply a sub-pipeline to each item (`over`, `as`, `collect`, `concurrency`, `onError: stop|skip|collect`)
- **filter** — keep items where sub-pipeline predicate is true (`keep_field`)
- **reduce** — sequential fold with accumulator (`init`, `item_as`, `acc_as`)
- **parallel** — run named branches concurrently, merge outputs (AbortController cancellation on failure)
- **retry** — wrap sub-pipeline with backoff policy (`attempts`, `backoff: constant|linear|exponential`)
- **gate** — pause for operator verdict (`name`, `prompt`, `timeout_ms?`, `collect?`); pluggable `GateProvider` (default: stdin); emits `gate.opened` / `gate.closed` / `gate.timeout` events via `onGateEvent`
- **agent** — dispatch an LLM/agent task to the fleet (`name`, `capability`, `prompt` template, `sovereignty?`, `timeout_ms?`, `collect?`); pluggable `AgentProvider` (no default — fail fast); `MyelinAgentProvider` publishes myelin v3 task envelopes over NATS and awaits the dispatch lifecycle; emits `agent.dispatched` / `agent.completed` / `agent.failed` / `agent.timeout` via `onAgentEvent`
- **tribunal** — model-diverse agent panel adjudicates a judgment call (`name`, `seats[]`, `tiebreaker?`, `confidence_bar?`, `on_defer: fail|continue`); fail-closed aggregation to `allow/deny/defer` with worst-case abstain interpretation, Gate-22 diversity rule (restrictive-only reassignment), tiebreaker on split; emits `tribunal.convened` / `tribunal.seat_voted` / `tribunal.tiebreak` / `tribunal.verdict` via `onTribunalEvent`; L1 of the governed-action stack (`docs/verdict-tribunal.md`)
- **governed** — the full L0→L1→L2 governed-action stack in one step (`name`, `tool`, `input_fields[]`, inline `policy`, `tribunal?`, `gate?`); L0 `evaluate()` allow skips the panel (zero LLM cost), deny halts, ask convenes the tribunal (or degrades to the gate when no tribunal is set); tribunal deny halts (refusals are terminal — no gate appeal), defer opens the gate; emits `governed.l0` / `governed.escalated` / `governed.resolved` via `onGovernedEvent`; composes evaluate()/tribunal/gate, never reimplements them (P-702)
- **research** — a chat model researches through read-only actions as tools (`name`, `model`, `prompt`, `system?`, `tools[]`, `bind?`, `max_rounds?`, `write_prompt?`, `empty_retries?`, `result_chars?`, `collect?`); the host injects models by name (`StepRunnerOptions.models`, e.g. `OpenAICompatibleChatModel`); every tool must be `effect: read` or the pipeline refuses to start; `bind` pins fields out of the model's reach; tools get an argv-only shell; JSONL trace into `StepRunnerOptions.traceDir`; `ResearchUnavailable` when the model is down; emits `research.started` / `research.round` / `research.completed` / `research.failed` via `onResearchEvent` (P-900..P-905, `docs/research-step.md`)

Types in `src/types/pipeline.ts` + `src/types/agent.ts` + `src/types/tribunal.ts` + `src/types/governed.ts`, dispatcher in `src/lib/step-runner.ts`, gate provider in `src/lib/gate-provider.ts`, agent providers in `src/lib/agent-provider.ts`, tribunal pure core in `src/lib/tribunal.ts`. Design rationale in `docs/iteration-primitives.md`, `docs/agent-actions.md`, and `docs/verdict-tribunal.md`.

### Step lifecycle events
Plain action steps emit `step.started` / `step.completed` / `step.failed` via the optional `StepRunnerOptions.onActionStepEvent` sink (`ActionStepEvent` in `src/types/pipeline.ts`) — the hook hosts use to surface per-step execution progress (e.g. the SOC demo's per-step Mattermost thread replies). Primitives keep their own channels (`onGateEvent`, `onAgentEvent`, `onTribunalEvent`, `onGovernedEvent`).

### SOC demo (P-800..P-806)
`examples/soc-demo/` — live on-stage composition of SOC processes from Mattermost (design: `design/soc-demo-mm-composer.md`). 21-block stub-safe palette, deterministic compose→execute validator (`A_VALIDATE_FLOW` + pure `validatePipeline` with sovereignty-annotation lint), catalog-bound composer with validator-retry loop, Mermaid→PNG rendering with fallback-to-source, and execution wiring with operator-ack gate (principal-checked) + per-step thread replies. Fully offline by default; every external adapter returns canned fixtures when its env key is unset. `bun examples/soc-demo/rehearse.ts` runs the 8 design scenarios.

### Agent actions (D/A/H complete)
Miner's step taxonomy maps 1:1 to pipeline steps: **D**eterministic = action, **A**gentic = `agent:`, **H**uman = `gate:`. Agent tasks are capability-addressed (`soc.triage.email`), sovereignty-constrained (`model_class: local-only` keeps confidential data off frontier models), and travel as myelin envelopes on `local.{principal}.{stack}.tasks.{capability}`. Pulse never talks to agents directly — it asks the bus. The `agent` capability (`requires: ["agent"]`) gives actions programmatic dispatch via `ctx.capabilities.agent(taskSpec)`. Demo: `examples/soc-triage/`.

### Flow
Flows connect source → pipeline → destination. Sources: inline, file, RSS, custom. Destinations: stdout, file, webhook, custom. Scheduling via interval or cron approximation.

## Key commands

```bash
bun test              # Run all 405 tests
bun run typecheck     # TypeScript check
bun src/cli.ts validate examples/simple-tree.json
bun examples/rss-pipeline/run-demo.ts  # Run RSS demo
```

## Working conventions

- Tree runner tests in `tests/` mirroring `src/lib/`
- Action/pipeline/flow tests create temp dirs in `beforeAll`, clean up in `afterAll`
- Step runner tests in `tests/step-runner.test.ts` (iteration primitives)
- Tree types in `src/types/pulse.ts`, action types in `src/types/action.ts`, pipeline step types in `src/types/pipeline.ts`, flow types in `src/types/flow.ts`
- No external runtime dependencies beyond commander, zod, yaml


## Naming

- **metafactory** -- always lowercase, one word. Not "Metafactory", not "Meta Factory". The GitHub org is `the-metafactory`, the repo name may be hyphenated (technical constraint), and the domains are `meta-factory.ai/.dev/.io` (DNS constraint). But the brand name is always `metafactory`.

## Critical Rules

- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.
- NEVER fabricate file names, class names, or architecture. If unsure, read the source.
- Fix ALL errors found during type checks, tests, or linting -- even if pre-existing or introduced by another developer. Never dismiss errors as "not from our changes." If you see it, fix it.
- Before fixing a bug or implementing a feature, ALWAYS check open PRs (`gh pr list`) and issues (`gh issue list`) first. Someone may already be working on it, or there may be a PR ready to merge that addresses it. Don't duplicate work -- review what exists before racing to write code.

- Arc integration uses `src/lib/arc.ts` (directory scanning via `~/.config/arc/pkg/repos/`) — NOT SQLite direct access. Arc owns its storage format; pulse consumes the public CLI contract.
- NEVER use empty catch blocks. Every catch must either: (a) log the error, (b) handle it meaningfully (e.g., return a fallback value with a comment explaining why), or (c) name the variable with `_err` and add a comment explaining why it's safe to ignore. Silently swallowing errors hides bugs.


## GitHub Labels (ecosystem standard)

All metafactory ecosystem repos use a shared label set. Do not create ad-hoc labels.

| Label | Description | Color | Purpose |
|-------|-------------|-------|---------|
| `bug` | Something isn't working | `#d73a4a` | Defect tracking |
| `documentation` | Improvements or additions to documentation | `#0075ca` | Docs work |
| `feature` | Feature specification | `#1D76DB` | Feature work |
| `infrastructure` | Cross-cutting infrastructure work | `#5319E7` | Infra/tooling |
| `now` | Currently being worked | `#0E8A16` | Priority: active |
| `next` | Next up after current work | `#FBCA04` | Priority: queued |
| `future` | Planned but not yet scheduled | `#C5DEF5` | Priority: backlog |
| `handover` | NZ/EU timezone bridge -- work session summary | `#F9D0C4` | Async handoffs |



Every issue must have at least one type label (`bug`, `feature`, `infrastructure`, `documentation`) and one priority label (`now`, `next`, `future`) if open.

## GitHub Issue Tracking
When working on a GitHub issue in this repo, keep the issue updated as you work. This is default agent behavior, not optional.

**On starting work:**
- Comment on the issue: what you're working on, which sub-task
- Example: `gh issue comment 1 --body "Starting: implement initial project structure"`

**During work:**
- When a sub-task checkbox is completed, tick it on the issue
- When you create a PR, link it to the issue (use `closes #N` or `gh pr create` with issue reference)

**On completing work:**
- Comment with a summary: what was done, what changed, any follow-up needed
- Tick completed checkboxes on both the GitHub issue AND any iteration plans
- If all checkboxes are done, close the issue

**Why:** GitHub is the shared collaboration surface. Team members and agents all read it. If you do work but don't update the issue, it looks like nothing happened.

## Standard Operating Procedures

This repo follows ecosystem SOPs defined in [compass](https://github.com/the-metafactory/compass). **Before starting work, identify which SOPs apply and Read them. Output the pre-flight line from each loaded SOP.**

| SOP | Activate when | File |
|-----|--------------|------|
| **Dev pipeline** | Creating branches, making PRs, starting any feature/fix work | `compass/sops/dev-pipeline.md` |
| **Versioning** | After merging PRs, before deploying, any version bump | `compass/sops/versioning.md` |
| **Worktree discipline** | Starting feature work (always — even solo) | `compass/sops/worktree-discipline.md` |
| **Design process** | Creating specs, design docs, or research docs | `compass/sops/design-process.md` |
| **Retrospective** | Post-work review, extracting process patterns | `compass/sops/retrospective-and-process-mining.md` |
| **New repo** | Bootstrapping a new repository in the ecosystem | `compass/sops/new-repo.md` |
| **PR review** | Reviewing a PR, before approving or merging | `compass/sops/pr-review.md` |

### Examples

**Starting a feature:**
```
Task: "Add a dashboard panel"
→ Activate: dev-pipeline + worktree
→ Read both SOPs
→ Output: "SOP: dev-pipeline | Branch: feat/g-300-panel | Prefix: feat:"
→ Output: "SOP: worktree | Worktree: ../pulse-panel | Branch: feat/g-300-panel | Main: untouched"
```

**After merging a PR:**
```
Task: "Merge PR #42"
→ After merge, activate: versioning
→ Read SOP
→ Output: "SOP: versioning | Current: v0.2.0 | Bump: patch → v0.2.1"
```

## Implementation Workflow

Pulse uses P-series feature numbering tracked via `blueprint.yaml` and iteration plans.

**Feature IDs (from blueprint.yaml):**
- **Iteration 1 — Execution Core:** P-100 (parser/validator), P-101 (scheduler), P-102 (executor), P-103 (PulseRunner), P-104 (CLI)
- **Iteration 2 — Pipe Model & Action Contract:** P-200 (Action contract), P-201 (passthrough pipe), P-202 (Pipeline primitive), P-203 (miner process import), P-205 (local/cloud dispatch), P-206 (pipeline YAML loader)
- **Iteration 3 — Flow & Ecosystem:** P-300 (Flow primitive), P-301 (D/A/H classification), P-302 (trace emission), P-303 (Arc package integration)
- **Iteration 4 — Runtime & Distribution:** P-400 (runtime adapters), P-401 (Cortex event bridge), P-402 (metafactory process runner)
- **Iteration 5 — NATS Message Bus:** P-500 (transport abstraction), P-501 (cue.fired executor), P-502 (cue.fired publisher), P-503 (process events on bus)
- **Iteration 6 — Agent actions:** P-600 (myelin envelope integration), P-601 (job publishing to NATS)
- **Iteration 7 — Governance upgrade (Magnus × RavenClaude synthesis):** P-700 (enforcement gate L0), P-701 (verdict tribunal L1), P-702 (governed-action stack L0→L1→L2), P-703 (diplomatic pouch, trust rung 1). Cross-repo: cortex G-1115 (MC governance tab), `compass/sops/peer-contact.md`. Plan: `docs/governance-upgrade-plan.md`.
- **Iteration 9 — Research step:** P-900 (JSON Schema action input), P-901 (effect + bind), P-902 (argv shell), P-903 (OpenAI-compatible chat model), P-904 (research step), P-905 (research trace). Design: `docs/research-step.md`.

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
- `docs/iteration-primitives.md` — Iteration primitives design (map, filter, reduce, parallel, retry)

**Sync rule:** Iteration plans exist in two places — `iterations/` (repo artifact, agents read it) and a GitHub Issue (trackable, commentable). When a checkbox is completed, update both.


## Blueprint-Driven Development

All ecosystem repos track features in `blueprint.yaml`. Before starting feature work, check the dependency graph:

```bash
# What's ready to work on? (dependencies satisfied)
blueprint ready

# Claim a feature
blueprint update {REPO_SHORT}:{ID} --status in-progress

# After PR merges
blueprint update {REPO_SHORT}:{ID} --status done
blueprint lint   # Validate graph integrity
```

**Statuses:** Only `planned`, `in-progress`, and `done` are settable. `ready`, `blocked`, and `next` are computed from the dependency graph.

**Cross-repo dependencies:** Use `{repo}:{ID}` format (e.g., `cortex:C-102`, `arc:A-100`). A feature is `blocked` if any dependency in another repo isn't `done`. Note: meta-factory's C-1xx IDs (cue artifact features) and cortex's C-1xx IDs (migration phases) are distinct namespaces — the `{repo}:` prefix disambiguates.

## Versioning & Releases

See `compass/sops/versioning.md` for the full procedure. Key repo-specific details:

- Version source of truth: `arc-manifest.yaml`
- Release title format: `"pulse vX.Y.Z -- Short Description"`
- Deploy command: `arc upgrade pulse`


## Multi-Agent Worktree Discipline

See `compass/sops/worktree-discipline.md` for the full procedure. Key repo-specific details:

- Worktree directory pattern: `../pulse-{slug}`
- Example: `git worktree add ../pulse-feature -b feat/{branch-name} main`

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
