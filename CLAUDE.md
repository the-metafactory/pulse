# Pulse — Process Execution Engine

Part of the [metafactory](../meta-factory/) ecosystem. v0.3.0.

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
- **Test:** `bun test` (97 tests across 11 files)
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

## Naming

- **metafactory** -- always lowercase, one word. Not "Metafactory", not "Meta Factory". The GitHub org is `the-metafactory`, the repo name may be hyphenated (technical constraint), and the domains are `meta-factory.ai/.dev/.io` (DNS constraint). But the brand name is always `metafactory`.

## Standard Operating Procedures

This repo follows ecosystem SOPs from [compass](https://github.com/the-metafactory/compass):

- **Development pipeline:** `compass/sops/dev-pipeline.md` — branches, commits, PR workflow
- **Versioning & releases:** `compass/sops/versioning.md` — semantic versioning, tags, GitHub releases
- **Worktree discipline:** `compass/sops/worktree-discipline.md` — multi-agent isolation
- **Design process:** `compass/sops/design-process.md` — research → decisions → specs → code
- **Retrospectives:** `compass/sops/retrospective-and-process-mining.md` — post-work pattern extraction
- **New repo onboarding:** `compass/sops/new-repo.md` — labels, webhooks, CLAUDE.md, bot.yaml

Read the relevant SOP when starting that type of work.

## Critical Rules

- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.
- NEVER fabricate file names, class names, or architecture. If unsure, read the source.
- Fix ALL errors found during type checks, tests, or linting -- even if pre-existing or introduced by another developer. Never dismiss errors as "not from our changes." If you see it, fix it.
- Before fixing a bug or implementing a feature, ALWAYS check open PRs (`gh pr list`) and issues (`gh issue list`) first. Someone may already be working on it, or there may be a PR ready to merge that addresses it. Don't duplicate work -- review what exists before racing to write code.
- Arc integration uses `src/lib/arc.ts` (directory scanning via `~/.config/arc/pkg/repos/`) -- NOT SQLite direct access. Arc owns its storage format; pulse consumes the public CLI contract.
- NEVER use empty catch blocks. Every catch must either: (a) log the error, (b) handle it meaningfully (e.g., return a fallback value with a comment explaining why), or (c) name the variable with `_err` and add a comment explaining why it's safe to ignore. Silently swallowing errors hides bugs.

## Implementation Workflow

Pulse uses P-series feature numbering tracked via `blueprint.yaml` and iteration plans.

**Feature IDs (from blueprint.yaml):**
- **Iteration 1 -- Execution Core:** P-100 (parser/validator), P-101 (scheduler), P-102 (executor), P-103 (PulseRunner), P-104 (CLI)
- **Iteration 2 -- Pipe Model & Action Contract:** P-200 (Action contract), P-201 (passthrough pipe), P-202 (Pipeline primitive), P-203 (miner process import), P-205 (local/cloud dispatch), P-206 (pipeline YAML loader)
- **Iteration 3 -- Flow & Ecosystem:** P-300 (Flow primitive), P-301 (D/A/H classification), P-302 (trace emission), P-303 (Arc package integration)
- **Iteration 4 -- Runtime & Distribution:** P-400 (runtime adapters), P-401 (Grove event bridge), P-402 (metafactory process runner)

**Workflow:**
```
1. Read the design spec (design/) and iteration plan (iterations/)
2. Pick next feature by dependency order from blueprint.yaml
3. Create feature branch: feat/p-{id}-{slug}
4. Implement against acceptance criteria in the iteration plan
5. PR -> review -> merge to main
6. Tick checkboxes in BOTH the iteration plan AND the GitHub tracking issue
```

**Commit conventions:** `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`

**Iteration plans:**
- `iterations/iteration-1.md` -- Execution Core (complete)
- `iterations/iteration-2.md` -- Pipe Model & Action Contract
- `iterations/iteration-3.md` -- Flow Orchestration & Ecosystem Integration

**Design specs:**
- `design/cue-architecture.md` -- Cue system (standalone artifacts, three-artifact model)

**Sync rule:** Iteration plans exist in two places -- `iterations/` (repo artifact, agents read it) and a GitHub Issue (trackable, commentable). When a checkbox is completed, update both.

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

## GitHub Issue Tracking (mandatory)

When working on a GitHub issue in this repo, keep the issue updated as you work. This is default agent behavior, not optional.

**On starting work:**
- Comment on the issue: what you're working on, which sub-task
- Example: `gh issue comment 12 --body "Starting: implement trace emission for beat-start/complete events"`

**During work:**
- When a sub-task checkbox is completed, tick it on the issue
- When you create a PR, link it to the issue (use `closes #N` or `gh pr create` with issue reference)

**On completing work:**
- Comment with a summary: what was done, what changed, any follow-up needed
- Tick completed checkboxes on both the GitHub issue AND `iterations/iteration-*.md`
- If all checkboxes are done, close the issue

**Why:** GitHub is the shared collaboration surface. JC, Andreas, and agents all read it. If you do work but don't update the issue, it looks like nothing happened.

## Versioning & Releases (mandatory)

Follow `compass/sops/versioning.md` for the full release workflow. Pulse-specific:

- Version tracked in `arc-manifest.yaml`
- **Patch**: Bug fixes, action fixes
- **Minor**: New actions, new capabilities, new cue types
- **Major**: Breaking changes to action API or pipeline schema
- Release title format: `"pulse vX.Y.Z — Short Description"`
- Deploy: `arc upgrade pulse`

## Multi-Agent Worktree Discipline (mandatory)

Never switch branches or stash in the main worktree when another agent might be active. Use `git worktree` instead. See `compass/sops/worktree-discipline.md` for full setup and conventions.

Pulse worktree directories: `../pulse-{slug}`.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
