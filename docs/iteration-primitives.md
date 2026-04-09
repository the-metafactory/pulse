# Iteration Primitives for Pulse Pipelines

**Status:** Design proposal — awaiting review
**Author:** Ivy (for Jens-Christian Fischer)
**Reviewer:** Luna
**Created:** 2026-04-09
**Scope:** Add functional composition primitives (`map`, `filter`, `reduce`, `parallel`) and step-level retry/timeout to pulse pipelines, without breaking the existing linear-pipe + TS-structure model.

---

## 1. Motivation

Pulse today is strictly linear. `runPipeline` in `src/lib/pipeline.ts:193` is a single `for` loop that merges each action's output into an accumulated `currentData` and passes it to the next action. Sources return exactly one record. There is no iteration, no branching, no concurrency within a pipeline.

This is elegant for pipe-style flows like `F_UL_HARVEST` (newsletter → extract URLs → evaluate → add to sift). It breaks down the moment a flow needs to **apply the same pipeline to a collection of items** and combine the results.

### The concrete trigger

While building the LinkedIn engagement reader (`linkedin-pulse` + pulse-actions LinkedIn adapters), we needed a flow that says:

> "List my recent posts. For each post, fetch engagement, snapshot it, compute the delta since last snapshot. Combine the per-post digests into one markdown report."

This is textbook `map` + `reduce`. There is currently no way to express it in pulse. The workarounds are:

1. **Shell loop outside pulse** — defeats the purpose of having a workflow engine
2. **One giant action that iterates internally** — moves control flow into the action, violating the "actions are pure TS-structure transformers" contract
3. **Hand-roll one flow per post** — not composable, unmaintainable

None of these are acceptable for a framework that Jens-Christian and others will build many similar workflows against. The right answer is to add iteration as a first-class concern in the pipeline runner itself.

### Why now

Several upcoming flows hit the same pattern:

- **F_LINKEDIN_PULSE_DIGEST** — per-post digest (map) + combine (reduce)
- **F_ECOSYSTEM_DIGEST** (exists, currently hardcoded) — fetch per-repo status in parallel + combine
- **F_NEXT_PICK** (exists) — rank per-repo + select top (map + reduce)
- **Daily briefing** (planned) — fetch calendar/email/work in parallel + summarize
- **Research aggregation** (planned) — research N topics in parallel + merge findings

Every one of these would benefit from the same small set of primitives. Adding them now is cheaper than each flow inventing its own ad-hoc iteration.

---

## 2. Goals and non-goals

### Goals

1. **Add `map`, `filter`, `reduce`, `parallel` as pipeline step primitives.** These cover the iteration patterns that actually recur across real pulse flows.
2. **Add step-level `retry` and `timeout`.** Orthogonal to iteration but immediately relevant once map runs real actions against rate-limited APIs.
3. **Preserve the `{...upstream, ...new}` TS-structure contract.** Actions see plain TS objects in and out. They never know about iteration. Composition lives in the pipeline runner.
4. **Preserve backwards compatibility.** Every existing flow must run unchanged. New primitives are opt-in and only appear when flows use them.
5. **Keep the surface area small.** One new step-type dispatcher in `runPipeline`, four new step handlers, one new YAML parser branch. No DSL, no expression language, no type magic.

### Non-goals

1. **Not adding `route` / `branch` / `if-else`.** Conditional routing is valuable but its use cases are thinner and its maintenance cost is higher. Defer until a concrete flow needs it.
2. **Not adding `flatMap`, `zip`, `window`, `groupBy`.** Genuinely rare in the flows we run. Handle ad-hoc in an action when they come up.
3. **Not supporting nested iteration in v1.** `map` inside `map` is intentionally unspecified. It will probably work accidentally; we don't commit to it.
4. **Not adding a pipeline-expression DSL.** No `where: "post.engagement > 5"`. Predicates are sub-pipelines that return a boolean field. This is more verbose but consistent with everything else.
5. **Not changing the action interface.** Actions remain `(input, ctx) -> output`. No iterator protocols, no generators, no streaming output.

---

## 3. Prior art (brief)

| System | map | filter | reduce | parallel | notes |
|---|---|---|---|---|---|
| Unix pipes | `xargs` | `grep` | (no) | (no) | Pulse's intellectual ancestor. Linear. |
| Kafka Streams / Beam | ✅ | ✅ | ✅ | ✅ | Heavy for streaming; pulse is batch. |
| Airflow | Dynamic task mapping | Branch operators | Usually in task | TaskGroup | Workflow-centric; heavier than needed. |
| Dagster | `DynamicOutput` | `Nothing` | Combine ops | multiprocess executor | Closest analog to what we want. |
| Prefect | `.map()` | `.filter()` | `.reduce()` | concurrency groups | Very close to FP semantics. |
| LangChain | `RunnableParallel`, `RunnableMap` | — | — | ✅ | Cleanest LLM-chain analog. |
| Haskell / Clojure | `map` | `filter` | `fold` | `pmap` | The conceptual basis. |

**Takeaway:** Every mature pipeline system converges on the same 4-5 primitives. The differences are in syntax and error/concurrency semantics. Pulse should not invent new semantics — it should pick known-good defaults and commit.

---

## 4. Design principles

1. **Actions are pure TS-structure transformers.** They receive `{...upstream}` and return `{...new}`. They never see iteration, concurrency, retry, or error-handling concerns. Those live in the runner.
2. **Composition is declarative YAML.** Control flow is visible in the pipeline.yaml without reading any TypeScript. A reader can trace data flow top-to-bottom.
3. **Step types are a discriminated union, not inheritance.** A pipeline step is either a string (action name) or an object with a single keyword (`map:`, `filter:`, `reduce:`, `parallel:`, `retry:`). Parser looks at the keyword to dispatch. No polymorphism.
4. **Fail loud by default.** Errors stop the pipeline. Opt-in to `skip` or `collect`. No silent data loss, ever.
5. **Concurrency is opt-in.** Default `concurrency: 1` (sequential). Deliberate — rate-limited APIs (LinkedIn, GitHub, Anthropic) punish accidental parallelism.
6. **Terminal reduction via regular actions is still valid.** A pipeline that ends with `A_FORMAT_REPORT` reading an upstream collection is just as legitimate as one using a `reduce:` step. The reduce primitive is for streaming / stateful aggregation; a terminal action is for "consume all at once". Both patterns should work.

---

## 5. The primitives

### 5.1 `map` — fan-out over a collection

Apply a sub-pipeline to each element of a collection. Same cardinality in → out. Sequential by default, concurrent with opt-in.

**YAML:**

```yaml
- map:
    over: posts              # field in upstream context holding the array
    as: post                 # name bound in each sub-pipeline invocation
    actions:                 # the sub-pipeline — a list of steps (strings or nested primitives)
      - A_LINKEDIN_POST_ENGAGEMENT
      - A_LINKEDIN_DIGEST_DELTA
    collect: digests         # field to write collected sub-pipeline outputs to
    concurrency: 1           # optional, default 1
    onError: stop            # optional: stop | skip | collect. Default: stop.
```

**Semantics:**

1. Read `upstream[over]`. If it's not an array, throw. If empty, write `upstream[collect] = []` and continue.
2. For each item `i` in the array:
   - Build sub-input: `{...upstream, [as]: item}`
   - Run the sub-pipeline via `runPipeline`
   - Capture the sub-pipeline's terminal output
3. If `concurrency > 1`, use a worker pool pattern (simple semaphore) to bound in-flight sub-pipelines. Ordering of results preserves input order regardless of completion order.
4. On error (see §6), behavior depends on `onError`.
5. Write `upstream[collect] = [...subPipelineOutputs]`. Each element is the terminal upstream of its sub-pipeline, NOT just the last action's return value — so downstream actions can access any field any sub-action produced.
6. Return the full upstream to the next step.

**TS-structure preservation:** each sub-pipeline run sees a normal linear pipeline with one extra upstream field (`post`). Actions inside the sub-pipeline receive and return TS objects as usual. The runner is the only code that knows iteration is happening.

### 5.2 `filter` — drop items that fail a predicate

Same shape as `map` but the sub-pipeline is a predicate: it must produce a boolean field that the runner reads to decide whether to keep the item.

**YAML:**

```yaml
- filter:
    over: posts
    as: post
    actions:
      - A_POST_RECENT_CHECK    # → { keep: true } or { keep: false }
    keep_field: keep           # which sub-pipeline output field is the predicate result
    collect: recent_posts
    concurrency: 1
    onError: stop
```

**Semantics:**

1. For each item, run the sub-pipeline with `{...upstream, post: item}`.
2. Read the sub-pipeline terminal output's `keep_field`. Must be a boolean. Anything else throws.
3. Collect only items whose predicate returned `true` into `upstream[collect]`.
4. Original array order is preserved.

**Note:** we explicitly do NOT support inline predicate expressions (`where: "post.age > 7d"`). The cost of introducing an expression DSL outweighs the syntactic savings for the number of filter steps we expect. If someone writes 20 similar filter predicates and the boilerplate hurts, we revisit.

### 5.3 `reduce` — stateful fold

Sequentially combine items into a single accumulated value. Distinct from map-plus-final-action because reduce is **inherently sequential and stateful**: iteration N depends on the output of iteration N-1.

**YAML:**

```yaml
- reduce:
    over: digests
    init:
      header: "# LinkedIn Daily Digest\n\n"
      body: ""
    item_as: digest          # each iteration sees upstream.digest
    acc_as: report           # each iteration sees upstream.report (== current accumulator)
    actions:
      - A_APPEND_DIGEST_MD   # reads report + digest, returns { report: <newReport> }
    collect: final_report    # after last iteration, write acc to upstream[collect]
    onError: stop
```

**Semantics:**

1. Initialize `acc = init` (any JSON structure).
2. For each item:
   - Build sub-input: `{...upstream, [item_as]: item, [acc_as]: acc}`
   - Run the sub-pipeline
   - Read `<subOutput>[acc_as]` as the new accumulator (must be present)
3. After the last item, write `upstream[collect] = acc`.
4. `reduce` is always sequential. `concurrency` is not meaningful here — fold is order-dependent by definition.

**Why reduce is distinct from "map + final action":**

| Aspect | map + final action | reduce |
|---|---|---|
| Holds all items in memory | Yes | No — only accumulator |
| Order-dependent | Unclear (runner can reorder) | Yes, strictly |
| Can early-terminate | No | Possible (future: `until:` predicate) |
| Streaming-friendly | No | Yes |
| Idiomatic for "fold" | No | Yes |

For pulse's current batch-oriented world, the memory and streaming distinctions are weak. But **intent clarity** matters: a `reduce` step says "this is an aggregation"; a terminal action says "this is a transformer that happens to read a collection." Different readers, different tools.

### 5.4 `parallel` — heterogeneous named branches

Run N sub-pipelines concurrently from the same upstream, merging their outputs into named fields. This is NOT iteration — it's fan-out to different work.

**YAML:**

```yaml
- parallel:
    branches:
      calendar:
        actions: [A_FETCH_CALENDAR]
      email:
        actions: [A_FETCH_EMAIL_DIGEST]
      work:
        actions:
          - A_FETCH_OPEN_WORK
          - A_RANK_WORK
    onError: stop            # stop | collect (skip doesn't make sense here)
```

**Semantics:**

1. Launch all branches concurrently, each with `{...upstream}` as input. Branches CANNOT see each other's intermediate state.
2. Wait for all branches to complete.
3. Merge outputs: for each branch `name`, write `upstream[name] = <terminal upstream of that branch>`. Branches NEVER overwrite upstream fields they didn't produce — results are namespaced.
4. If any branch fails and `onError: stop` (default): cancel remaining branches (best-effort) and throw. If `onError: collect`: wait for all, then return `{...upstream, [name]: result_or_error}`.

**Concurrency:** unlimited by default — that's the whole point of parallel. If you need to bound it (e.g. "run 3 research agents but no more"), do it with an explicit semaphore action or nested `map` with `concurrency: 3`.

### 5.5 `retry` — composition primitive for reliability

Orthogonal to iteration but requested in the same design pass. Wraps a sub-pipeline with retry policy.

**YAML (wrapper form):**

```yaml
- retry:
    attempts: 3
    backoff: exponential     # constant | linear | exponential
    initial_delay_ms: 500
    max_delay_ms: 10000
    on: [VoyagerError, ParseError]    # optional: retry only these error types
    actions:
      - A_LINKEDIN_POST_ENGAGEMENT
```

**YAML (inline shortcut for single-action case):**

```yaml
- { action: A_LINKEDIN_POST_ENGAGEMENT, retries: 3, timeout: 10s, backoff: exponential }
```

**Semantics:**

1. Run the inner sub-pipeline.
2. On failure: check if the error type is in `on` (or always retry if `on` is omitted). If retryable and attempts remain, wait per `backoff` policy, then re-run the ENTIRE inner sub-pipeline from the start. Sub-pipelines are NOT resumable mid-way.
3. After `attempts` attempts, propagate the last error to the enclosing step.
4. `timeout` on an action kills the action if it exceeds the duration and treats it as a retryable error (subject to the `on:` filter).

**Why `retry` is a composition primitive and not an action metadata field:** it can wrap ANY sub-pipeline, not just one action. A map step with retry around each item's sub-pipeline is a common pattern.

**Relationship to `map.onError`:** independent concerns. `retry` handles transient failures within a single item. `map.onError` handles what the parent step does when an item's sub-pipeline has ultimately failed (after exhausting retries). You can combine them freely.

---

## 6. Error semantics — a single table

| Step type | Default onError | Valid values | `skip` means | `collect` means |
|---|---|---|---|---|
| `map` | `stop` | stop, skip, collect | Omit the failed item from the collected output; continue | Include `{error: ...}` in place of the result |
| `filter` | `stop` | stop, skip | Treat failing predicate as "don't keep"; continue | n/a |
| `reduce` | `stop` | stop | n/a | n/a |
| `parallel` | `stop` | stop, collect | n/a | Include `{error: ...}` for failed branches |
| `retry` | (N/A — error is the trigger) | — | — | — |

**Principle:** `stop` is the default everywhere. Silent data loss is worse than loud failure. Users must explicitly ask for `skip` or `collect`.

---

## 7. Concurrency model

### Default: sequential

Every iteration primitive defaults to `concurrency: 1`. This is deliberate and non-negotiable as a default because:

1. **Rate-limited APIs dominate real flows.** LinkedIn Voyager has undocumented limits. GitHub has documented ones. Anthropic has tier-dependent limits. Accidentally firing 20 parallel requests against them is a foot-gun with long cool-down.
2. **Debugging sequential runs is vastly easier.** Interleaved output and non-deterministic error ordering make parallel runs hell to diagnose.
3. **Opt-in parallelism is explicit intent.** The flow author thought about it.

### Higher concurrency: simple worker pool

When `concurrency: N` with N > 1, use a trivial semaphore:

```typescript
async function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function runOne() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runOne));
  return results;
}
```

Result ordering matches input order regardless of completion order (the `results[idx]` assignment preserves it). No dependency, ~15 lines.

### `parallel` is different

`parallel`'s whole purpose is concurrent branches. It has no `concurrency` field — it always runs all branches in parallel (typically 2-5 branches, not large N). If you need to bound "parallel" to "run at most K branches at a time", that's a sign you actually want `map` with `concurrency: K`.

---

## 8. Implementation sketch

### 8.1 YAML schema extension

Before:

```yaml
actions:
  - A_FOO
  - A_BAR
```

After (additive — old form still valid):

```yaml
actions:
  - A_FOO                              # string = action name (unchanged)
  - map:                               # object with known keyword = primitive
      over: items
      as: item
      actions: [A_BAZ, A_QUX]
  - retry:
      attempts: 3
      actions: [A_RETRY_ME]
  - A_FINAL                            # strings and objects can interleave
```

### 8.2 Step type (TypeScript)

```typescript
// src/types/pipeline.ts (new or updated)

export type PipelineStep =
  | string                              // action name (existing)
  | { map: MapStepSpec }
  | { filter: FilterStepSpec }
  | { reduce: ReduceStepSpec }
  | { parallel: ParallelStepSpec }
  | { retry: RetryStepSpec };

export interface MapStepSpec {
  over: string;
  as: string;
  actions: PipelineStep[];
  collect: string;
  concurrency?: number;         // default 1
  onError?: "stop" | "skip" | "collect";  // default "stop"
}

export interface FilterStepSpec {
  over: string;
  as: string;
  actions: PipelineStep[];
  keep_field: string;
  collect: string;
  concurrency?: number;
  onError?: "stop" | "skip";
}

export interface ReduceStepSpec {
  over: string;
  init: unknown;
  item_as: string;
  acc_as: string;
  actions: PipelineStep[];
  collect: string;
  onError?: "stop";
}

export interface ParallelStepSpec {
  branches: Record<string, { actions: PipelineStep[] }>;
  onError?: "stop" | "collect";
}

export interface RetryStepSpec {
  attempts: number;
  backoff?: "constant" | "linear" | "exponential";
  initial_delay_ms?: number;
  max_delay_ms?: number;
  on?: string[];                // error class names
  actions: PipelineStep[];
}
```

### 8.3 Runner dispatcher

The core change to `runPipeline` is replacing the existing linear loop with a step dispatcher:

```typescript
async function runSteps(
  steps: PipelineStep[],
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions
): Promise<Record<string, unknown>> {
  let current = { ...upstream };
  for (const step of steps) {
    current = await runStep(step, current, options);
  }
  return current;
}

async function runStep(
  step: PipelineStep,
  upstream: Record<string, unknown>,
  options: ActionRunnerOptions
): Promise<Record<string, unknown>> {
  if (typeof step === "string") {
    // Existing action path — no change
    const result = await runAction(step, upstream, options);
    if (!result.success) throw new StepFailure(step, result.error);
    return { ...upstream, ...(result.output ?? {}) };
  }

  if ("map" in step) return runMap(step.map, upstream, options);
  if ("filter" in step) return runFilter(step.filter, upstream, options);
  if ("reduce" in step) return runReduce(step.reduce, upstream, options);
  if ("parallel" in step) return runParallel(step.parallel, upstream, options);
  if ("retry" in step) return runRetry(step.retry, upstream, options);

  throw new Error(`Unknown pipeline step shape: ${JSON.stringify(step)}`);
}
```

Each primitive handler (`runMap`, `runFilter`, etc.) is ~30-60 lines. Implementation deferred to the build phase; the above is the dispatch skeleton.

### 8.4 Existing `runPipeline` backwards compatibility

The existing `runPipeline` signature stays:

```typescript
export async function runPipeline(
  pipeline: PipelineDef,
  initialInput: Record<string, unknown>,
  options: ActionRunnerOptions & { mode?: "local" | "cloud" }
): Promise<PipelineResult>
```

Internally, it wraps `runSteps`:

```typescript
export async function runPipeline(pipeline, initialInput, options) {
  const startTime = Date.now();
  try {
    const output = await runSteps(pipeline.actions, initialInput, options);
    return { success: true, output, steps: [...], durationMs: ... };
  } catch (err) {
    return { success: false, output: ..., error: ..., steps: ..., durationMs: ... };
  }
}
```

Legacy `pipeline.actions` arrays of pure strings continue to parse, dispatch through the string branch, and behave exactly as before. The only observable change is that new step types are accepted alongside strings.

### 8.5 YAML parser

`parseSimpleYaml` in `src/lib/pipeline.ts` currently assumes `actions` is `string[]`. It needs to accept mixed arrays. Either:

- **Extend the minimal YAML parser** to handle nested objects (simplest for inline cases, hardest for parser maintenance)
- **Adopt a proper YAML library** for pipeline.yaml parsing (`yaml` npm package, ~100KB). Flow.yaml already likely benefits; promoting the parser is worth it for this feature.

Recommendation: adopt the `yaml` package. The cost of maintaining a hand-rolled parser against increasingly structured YAML is higher than a dependency.

---

## 9. Worked example — F_LINKEDIN_PULSE_DIGEST

### Before (broken, as of 2026-04-09)

```yaml
# pipeline.yaml
name: P_LINKEDIN_PULSE_DIGEST
actions:
  - A_LINKEDIN_POST_COMMENTS
  - A_LINKEDIN_DIGEST_DELTA
```

Problems:
- Single post only (hardcoded activityUrn in flow.yaml input)
- A_LINKEDIN_POST_COMMENTS fetches live data but doesn't write to SQLite
- A_LINKEDIN_DIGEST_DELTA reads SQLite but that's populated by a separate `linkedin-pulse watch` run
- No way to combine per-post digests into one report

### After (with iteration primitives)

```yaml
# flow.yaml
name: F_LINKEDIN_PULSE_DIGEST
source:
  type: command                                # new source type (separate follow-up)
  cmd: "linkedin-pulse my-posts --json"
destination:
  type: file
  path: ~/work/ai-consulting/reports/linkedin-daily.md
  format: markdown
pipeline: ./pipeline.yaml
```

```yaml
# pipeline.yaml
name: P_LINKEDIN_PULSE_DIGEST
actions:
  # Optional: filter to posts within a recency window
  - filter:
      over: posts
      as: post
      actions:
        - A_POST_WITHIN_WINDOW          # returns { keep: bool }
      keep_field: keep
      collect: recent_posts

  # For each recent post: snapshot + digest with retry on transient failures
  - map:
      over: recent_posts
      as: post
      concurrency: 1                    # sequential for LinkedIn rate-limit safety
      onError: collect                  # one failed post shouldn't kill the whole report
      actions:
        - retry:
            attempts: 3
            backoff: exponential
            on: [VoyagerError, TlsFingerprintError]
            actions:
              - A_LINKEDIN_POST_ENGAGEMENT
        - A_LINKEDIN_SNAPSHOT_POST      # writes to sqlite (new thin action over `linkedin-pulse snapshot`)
        - A_LINKEDIN_DIGEST_DELTA       # reads sqlite, computes delta
      collect: per_post_digests

  # Combine per-post digests into one markdown report
  - reduce:
      over: per_post_digests
      init:
        header: "# LinkedIn Daily Digest\n\n"
        body: ""
      item_as: digest
      acc_as: report
      actions:
        - A_APPEND_DIGEST_MARKDOWN      # reads report + digest, returns { report: newReport }
      collect: final_report

  # Format the accumulated report for the file destination
  - A_FORMAT_FINAL_REPORT               # reads final_report, emits { digest: markdown }
```

**What each primitive contributes:**

- `filter` — ignore stale posts without forcing the filter logic into every downstream action
- `map` — per-post processing; sequential by default because LinkedIn hates concurrent requests
- `retry` — transparent recovery from Voyager flakiness
- `reduce` — build the report incrementally (a pure "map + final action" would work here too; the design doc uses reduce to demonstrate the primitive)

**Every action in this flow remains a pure TS-structure transformer.** None of them know that iteration is happening. The pipeline.yaml is the only place composition is visible.

---

## 10. Backwards compatibility

**Guarantees:**

1. Every existing pipeline.yaml parses and runs identically. Strings-only action arrays are unchanged.
2. `runAction`, `runPipeline`, `runFlow` keep their existing signatures.
3. `PipelineDef` gains a richer `actions` type (`PipelineStep[]` instead of `string[]`) but TypeScript's structural typing means any string array still satisfies the new type.
4. No changes to action manifests, action runtime, or capability injection.

**Migration:** none required for existing flows. New primitives are strictly additive.

---

## 11. Open questions for review

1. **Should `reduce` support early termination via an `until:` predicate sub-pipeline?** Clean FP says yes. YAGNI says no. I lean no for v1.

2. **Should `parallel` branches share upstream copy-by-reference or copy-by-value?** Copy-by-value is safer (no accidental cross-branch mutation) but doubles memory for large upstreams. Copy-by-reference is cheaper but risky if actions mutate. JavaScript's lack of immutability makes this a real question. I lean copy-by-value via `structuredClone` at the branch boundary.

3. **Concurrency > 1 on `filter`: is ordering preservation a hard requirement?** I specified yes. Alternative: return items in completion order. I prefer preservation for predictability; the cost is minor (`results[idx]` slot assignment).

4. **Retry backoff policy defaults.** I proposed `exponential` as an example but specified no default. Should the default be `constant` (simpler mental model) or `exponential` (better for real APIs)? I lean exponential with `initial_delay_ms: 500, max_delay_ms: 10000`.

5. **Where do step failures get reported in `PipelineResult.steps`?** Currently `steps: [{action, success, durationMs, error}]` assumes each step is a single action. With nested primitives, step granularity is murky. Option A: flat list with synthetic step names like `"map[3/10]: A_FOO"`. Option B: nested tree mirroring pipeline shape. Option A is simpler and more grep-friendly. Option B is more structured but harder to render. I lean A.

6. **The hand-rolled `parseSimpleYaml` vs adopting the `yaml` npm package.** I recommended adopting `yaml`. Do we want to accept the dependency, or preserve zero-dep pipeline parsing and extend the hand-rolled parser? If we preserve zero-dep, nested step objects get awkward quickly.

7. **Should there be an `--input field=value` CLI flag on `pulse flow run`** to unblock single-flow-per-URN workflows in the interim, independent of this primitive work? Strictly out of scope for this doc but the LinkedIn flow needs it regardless.

8. **Nested iteration.** Does `map` inside `map` need to work in v1, or are we OK declaring it "undefined behavior, probably works, no guarantees"? My draft spec does not explicitly support it but the recursive dispatch in `runStep` means it'll probably work accidentally.

9. **Is `command` source type (shown in the worked example) in-scope for this doc, or a separate proposal?** I've been treating it as a separate follow-up but it's needed to make the primitives useful in real flows.

---

## 12. Explicitly NOT in this design

For the record, so reviewers don't ask "why not X?":

- **`route` / `branch` / `if-else`** — deferred. No concrete use case yet. Revisit when one appears.
- **`flatMap`** — deferred. Rare. Can be done as `map` followed by an action that flattens.
- **`zip` / `join`** — deferred. Ad-hoc in an action.
- **`window` / `groupBy`** — streaming-specific. Pulse is batch.
- **Expression DSL for predicates** (`where: "post.age > 7d"`) — deferred. Predicate sub-pipelines are consistent with everything else.
- **Nested iteration as a formal feature** — see open question 8.
- **Streaming reduce / partial results** — deferred. Current batch model doesn't need it.
- **Dynamic pipeline construction** (a pipeline built by an action at runtime) — explicitly rejected. Pipelines must be static and inspectable at load time.

---

## 13. Implementation work breakdown

Assuming the design above is approved, the work is:

### pulse (~3-4 hours)

1. **Types** — extend `PipelineDef.actions` to `PipelineStep[]`, add all step-spec interfaces (`src/types/pipeline.ts`)
2. **Parser** — adopt `yaml` npm package (replaces `parseSimpleYaml`); update `loadPipeline` to parse mixed step arrays
3. **Runner dispatcher** — extract `runStep` from current linear loop; implement the 5 handlers (`runMap`, `runFilter`, `runReduce`, `runParallel`, `runRetry`)
4. **Concurrency helper** — the ~15-line worker pool
5. **Error types** — `StepFailure`, `MapItemFailure` etc. with enough structure for `onError` policies to act on
6. **Result reporting** — flat `PipelineResult.steps` with synthetic names (per open question 5)
7. **Tests** — one test per primitive (happy path + one error path), one regression test for legacy string-only pipelines
8. **Documentation** — `docs/creating-a-pipeline.md` update with the new primitives

### pulse-actions (~1 hour)

1. Rewrite `F_LINKEDIN_PULSE_DIGEST/pipeline.yaml` using `map` + `reduce` per §9
2. Add `A_LINKEDIN_SNAPSHOT_POST` action (thin wrapper over a new `linkedin-pulse snapshot <urn>` command)
3. Add `A_APPEND_DIGEST_MARKDOWN` reduce-fold action
4. Add `A_FORMAT_FINAL_REPORT` terminal action
5. Add `A_POST_WITHIN_WINDOW` filter predicate action
6. Version bump to 1.3.0, commit, push, arc reinstall

### linkedin-pulse (~30 min)

1. Add `linkedin-pulse snapshot <activity-urn>` CLI command — single-post version of `watch`
2. Commit, push

### Separate follow-up (not in this design)

- `pulse.FlowSource` gains `{type: "command", cmd: string}` — or existing `{type: "custom", fn}` is used directly from TypeScript (flows in TS instead of YAML)
- `pulse flow run --input key=value` CLI flag

---

## 14. How to review this doc

Luna, the three most valuable questions to weigh in on:

1. **Scope of the primitive set.** Is `map + filter + reduce + parallel + retry` the right list? Would you add or remove any? Per §11 question 1 especially — is `reduce` pulling its weight as a distinct primitive or is it syntactic sugar for "map + final action"?

2. **Error semantics defaults.** Is "stop by default, opt-in to skip/collect" the right call? Per §6. Alternative: "collect by default, opt-in to stop" — more forgiving but risks silent data loss.

3. **The `parseSimpleYaml` vs `yaml` package decision.** Per open question 6. This affects every pulse flow going forward, not just iteration.

Secondary but valuable:

4. Naming — any of the keywords (`map`, `filter`, `reduce`, `parallel`, `retry`) should be renamed for clarity?
5. Do you see a use case in the next 1-2 quarters that would need `route` / `branch`, such that we should include it now?
6. Anything in §12 (explicitly excluded) that you think should be IN v1?

---

## Appendix: decision log

| Date | Decision | Why |
|---|---|---|
| 2026-04-09 | Use `map + filter + reduce + parallel` as the primitive set; defer `route` | Covers every concrete flow we have in mind; route lacks a real use case today |
| 2026-04-09 | Default `concurrency: 1` | Rate-limited APIs dominate; accidental parallelism is a foot-gun |
| 2026-04-09 | Default `onError: stop` | Silent data loss is worse than loud failure; aligns with Zod-parse-boundary philosophy used elsewhere in the stack |
| 2026-04-09 | Include `retry` in this design (not a separate one) | Requested by JC; orthogonal to iteration but composes with every other primitive |
| 2026-04-09 | Predicate sub-pipelines instead of expression DSL | One less thing to maintain; consistent with the rest of the composition model |
| 2026-04-09 | Flat `PipelineResult.steps` reporting | Grep-friendly; tree structure is available from the pipeline YAML itself if needed |
| 2026-04-09 | Adopt `yaml` npm package (recommended, pending review) | Cheaper than maintaining a hand-rolled parser against increasingly structured YAML |
