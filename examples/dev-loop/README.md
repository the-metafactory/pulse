# Dev-loop — the per-slice dev pipeline as a pulse process definition

The metafactory dev pipeline — `dev → review → disposition → merge → release` —
expressed as a **pulse process definition**. This is the executable form of the
procedural tier in cortex `docs/design-agentic-dev-pipeline.md` **§3.3** (the
"`dev-loop.process.yaml` sketch"), realised against pulse#15's `agent:` step
contract (P-600/P-601).

It is the F-3 slice-1 artifact for epic **cortex#835**: turn the §3.3 sketch
into a real, validating definition — and, just as importantly, surface exactly
where the design out-runs what pulse's format can express today.

```
slice ──► agent: implement ──► agent: review ──► A_DISPOSITION ──► A_MERGE_PRECHECK ──► agent: approve ──► gate ──► agent: release
          dev.implement        code-review.*     classify          CI/MERGEABLE/        merge.approve      release   release.cut
          (worktree+CC+PR)      (Echo/Holly)      fix-small/big     staleness            five-check+squash  decision  version/deploy/announce
          A                     A                 D                 D                    A                  H         A
```

## The D/A/H mapping (design §3.3)

pulse#15 made three step kinds first-class; the SOP stages map onto them:

| § 3.3 stage | pulse step | kind | capability / name |
|---|---|---|---|
| implement the slice | `agent:` | **A** | `dev.implement` |
| adversarial review | `agent:` | **A** | `code-review.typescript` |
| classify findings | `A_DISPOSITION` | **D** | fix-small / defer-big |
| pre-merge gate | `A_MERGE_PRECHECK` | **D** | CI green / MERGEABLE / fresh |
| approver-bot | `agent:` | **A** | `merge.approve` (five checks) |
| release decision | `gate:` | **H** | `release-decision` (always-human) |
| cut the release | `agent:` | **A** | `release.cut` |

Each `agent:` step is capability-addressed and sovereignty-constrained. Pulse
publishes `local.{principal}.{stack}.tasks.{capability}` (Offer mode, queue
group) and resolves on `dispatch.task.completed|failed` by `correlation_id` —
the exact contract cortex's dispatch listener + lifecycle publisher speak. The
`agent:` provider mints the `task_id` and reports it via `onDispatched`, so the
driver can correlate `agent.dispatched` with `agent.completed`.

`sovereignty.classification: local` keeps repo context and code on the
principal's own stack — none of these stages federate (cross-principal review is
the §3.7 payoff, a later slice, and would flip to `federate:` + a
`federated.*` subject).

## Run it

The definition is exercised by its test, the way soc-triage / build-journal are
exercised by their run scripts — through pulse's **real** loader and runner:

```bash
# Validates the definition through loadPipeline (runs validateSteps) and
# round-trips the happy path with a scripted fleet + auto-gate.
bun test examples/dev-loop/pipeline.test.ts

# It is also picked up by the repo-wide gate:
bun test
```

There is intentionally **no `run-demo.ts`** in this slice: F-3 slice 1 is the
*definition + its validation*. A live driver (pilot hosting the run per errand,
the §3.4 reactor) is the consumer — a later slice — not part of this artifact.

## Engine gaps — what the format CANNOT express yet

The design §3.3 sketch and the §3.5 gate table assume engine constructs pulse
does not have. The definition therefore encodes the **happy-path single pass**
(the spine the loop walks when review approves first cycle) — the largest
faithful subset the current format validates and runs. The rest is the
loop-driver's (pilot's) job today, and becomes pulse constructs when these gaps
close. Each is a **P-NNN candidate** for the pulse engine.

### G1 — bounded fix-cycle (`loop:` / `until:` keyed on a data verdict)

> design §3.3: `agent: dev.implement   # fix cycle (cap: 5, then waiting_human)`
> design §3.5: `review-cycle cap = 5 per PR → waiting_human`

The fix-cycle is "repeat *implement → review → disposition* **while**
`review.verdict == changes-requested`, capped at **5**, then escalate to a human
gate." pulse has no such construct:

- `retry:` loops on a **thrown `StepFailure`**, not on a **payload verdict
  value** — a `changes-requested` review is a *successful* step with a verdict
  field, so `retry:` never fires.
- On exhaustion `retry:` **re-throws**; it cannot route to a `waiting_human`
  gate. The design needs *escalate-on-exhaust*, not *fail-on-exhaust*.

→ **P-NNN candidate:** a bounded-iteration primitive
`loop: { until: <payload predicate>, max: N, on_exhaust: <gate|step> , actions: [...] }`.
Until then the §3.4 reactor counts cycles and re-dispatches `dev.implement` with
the findings refs; the cap and the `waiting_human` escalation live in pilot's
errand store.

### G2 — conditional branching

Two stages need to fork the pipeline and cannot:

- **disposition** — `fix-small` (re-implement) vs `defer-big` (file a follow-up)
  is a branch; `A_DISPOSITION` can only emit a *plan*, not take it.
- **gate routing** — a `gate: fail` raises `StepFailure` and **aborts** the
  whole pipeline. There is no `on_fail:` branch (e.g. "on hold, notify and
  stop cleanly" vs "on reject, loop back"). Here that abort *is* the desired
  "hold the release" semantics — but it is a blunt instrument, not a branch.

→ **P-NNN candidate:** a `switch:` / `when:` primitive selecting a sub-pipeline
on a payload predicate, and an `on_fail:` branch target for `gate:`.

### G3 — §3.5 gate / cap configuration has no schema home

The §3.5 "autonomy dial" is **data, not code** — but pulse's `gate:` carries
only `name` / `prompt` / `timeout_ms`. These have nowhere to live in the
definition:

| §3.5 control | needs |
|---|---|
| claim veto (60s) / pre-merge veto (30s) | a timed, default-pass gate variant |
| fleet concurrency cap (default 3) | a run-level resource budget |
| per-errand / per-run cost budget → hard stop | a run-level budget + stop verdict |
| dead-man's-switch (N failed slices → pause) | cross-run failure accounting |
| review-cycle cap (→ G1) | bounded-loop cap |

→ **P-NNN candidate:** a `policy:` / `limits:` block on the process definition
(or flow) for run-level caps, plus a `mode: veto` gate variant (timed,
default-pass). Today these are enforced by the driver (pilot) and the
config-split `policy` layer, not by the process definition.

### G4 — declarative step-output → routing

G1 and G2 both need to read a prior step's output (e.g. the review verdict) and
route on it *inside the definition*. pulse accumulates step outputs into the
payload (and prompt templates can `{interpolate}` them), but there is **no
declarative predicate/routing surface** over that payload. Only the driver,
holding the run state, can branch today.

→ **P-NNN candidate:** a payload-predicate expression usable by `loop.until`,
`switch.when`, and `gate.on_fail`.

## Files

| File | Role |
|---|---|
| `pipeline.yaml` | the process definition (the artifact) — D/A/H steps + inline gap notes |
| `A_DISPOSITION/` | **D** — classify review findings fix-small / defer-big (pure data) |
| `A_MERGE_PRECHECK/` | **D** — CI green / MERGEABLE / head-SHA fresh (the mechanical merge half) |
| `pipeline.test.ts` | validates through `loadPipeline` + round-trips through `runPipelineFromYaml` |

## References

- cortex `docs/design-agentic-dev-pipeline.md` §3.3 (D/A/H mapping), §3.4 (event
  walk), §3.5 (gate/cap table) — the design this implements.
- pulse#15 (P-600/P-601) — the `agent:` step contract this builds on.
- cortex#835 — the dev-loop epic; this is F-3 slice 1.
