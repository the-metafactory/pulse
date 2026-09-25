# Pulse

The execution engine of the metafactory ecosystem. Defines the language for *what runs* and *how it is shaped, packaged, and triggered*.

## Language

### Execution shapes

**Process**:
The ecosystem-facing, distributable unit that metafactory ships and arc installs. Resolves inside pulse to exactly one runtime shape (Pipeline, Flow, or Tree). Not a runtime primitive itself.
_Avoid_: using "Process" for an internal runtime construct.

**Action**:
The atomic, pure unit of work — declares required capabilities, receives them injected, runs identically local or cloud.

**Pipeline**:
The authoring shape for in-process data transformation — steps share one passthrough context; branching-in-the-small handled by composition primitives. The default unit of work.

**Flow**:
The deployment shape — binds a unit of work to a source + destination + schedule. The only shape that touches the outside world and the clock.

**Tree**:
The orchestration shape for coarse-grained dependency graphs — independent nodes with explicit dependencies, parallel readiness, per-node retry/timeout.

### Data & capability

**Payload**:
The data record that flows step-to-step through a Pipeline, accumulating fields via passthrough. What the work operates on. An Action is `(Payload, Context) → Payload`.
_Avoid_: "upstream", "input object", "context" (for the data).

**Context**:
The injected runtime services for an Action — capabilities, env, trace (`ActionContext`). What the work can do and observe. Never the data.

**Passthrough**:
The rule that an Action returns the untouched siblings of the fields it consumed, so the Payload grows monotonically down the Pipeline.

**Effect**:
What an Action declares it does to the world, in its manifest: `read` (gathers only) or `write` (sends, posts, drafts, changes state). Absent counts as not read. A research step offers a model `read` Actions only.

### Runtime

**Engine**:
Pulse as a whole — the thing that executes Processes. Singular.

**Tree Runner**:
The component that executes a Tree (a dependency graph). Class name `PulseRunner` is historical; it runs Trees only, not Pipelines or Flows.
_Note_: Scheduler and Executor are Tree-Runner implementation, not language.

**Transcript**:
The JSONL log of one research step's run (model turns, tool calls, arguments, results), written to a host-given directory. A debugging record, not a Trace.
_Avoid_: "trace" for it — Trace is the miner-owned record.

### Capability

**Capability**:
A named, injectable power an Action can require and receive (llm, fetch, shell, readFile, writeFile, kv).

**Capability requirement**:
The declared `requires: [...]` entry in an Action's manifest.

**Capability implementation**:
The concrete function injected at runtime to satisfy a requirement.

**Capability injection**:
The runtime supplying implementations for an Action's requirements — the mechanism that keeps Actions pure (they never import their dependencies).

**Mode**:
Where an Action runs: `local | cloud`. Same code, different mode.

**Capability provider**:
The per-mode source of capability implementations.

### Steps & primitives

**Step**:
The umbrella for one slot in a Pipeline. `Step = Action | Primitive`.

**Primitive**:
A built-in operation the runner dispatches — capability-free, not an authored artifact. Contrast with Action.
_Avoid_: "composition primitive" as the blanket term (misdescribes control primitives like gate).

**Composition primitive**:
A Primitive that wraps a sub-pipeline: map, filter, reduce, parallel, retry.

**Control primitive**:
A leaf Primitive that alters control flow without a sub-pipeline: gate (future: sleep, wait-for-event).

### Triggering

**cue.fired**:
The event pulse subscribes to — the boundary signal that a Cue's condition was met (by metafactory) and a bound Process should run. Pulse's job starts here.
_Avoid_: "trigger" as a noun.

## Foreign terms (metafactory-owned)

Pulse *references* these but never *owns* them. Defined here only so `cue.fired` reads clearly. Pulse never evaluates a Cue or resolves a Binding.

**Cue**:
An activation condition (event match, schedule, state threshold, intent pattern). A standalone registry artifact. Evaluated by metafactory.

**Binding**:
The linkage connecting a Cue to a target Process, with capability grants and priority. A standalone registry artifact. Resolved by metafactory.

**Trace**:
The record of a Process execution. Pulse *emits* it; miner *consumes* it and *owns its schema*, mining it for process patterns. Distinct from a span context.
_Avoid_: using "trace" for the observability span (`traceId`/`spanId`) — that is a generic span context, not this artifact.

**Envelope** (Myelin envelope):
The universal message wrapper — "one schema for all signals." Myelin (L3) owns the schema. Pulse integration is *future* (blueprint: actions produce/consume envelopes; process events carry sovereignty) — myelin sprang up after pulse.

**Sovereignty**:
Metadata declared in the Envelope that travels with the message. Myelin-owned. Pulse will attach it to process events (future).

## Relationships

- A **Process** resolves to exactly one runtime shape: a **Pipeline**, a **Flow**, or a **Tree**.
- A **Flow** wraps exactly one **Pipeline** (today) with a source and destination. Wrapping a **Tree** is a deliberate future extension, not an implied capability.
- An **Action** is the atomic leaf inside any shape.
- **Pipeline** and **Tree** topologically overlap (a linear chain is a degenerate graph); both are kept because they optimize for different authoring intents — data-passthrough vs dependency-orchestration.
- A **Step** is an **Action** or a **Primitive**. A **Primitive** is a **Composition primitive** or a **Control primitive**.
- **Actions** are authored and require **Capabilities**; **Primitives** are built-in and owned by the runner. (This is why gate cannot be an Action — it needs the runner's pause/abort machinery, not a capability.)
- Trigger path: metafactory evaluates a **Cue**, resolves its **Binding**, emits **cue.fired**; pulse consumes **cue.fired** and runs the bound **Process**.

## Flagged ambiguities

- "Process" was both the engine's tagline ("Process Execution Engine") and a metafactory artifact — resolved: Process = the packaged/installable unit; Pipeline/Flow/Tree = the internal runtime shapes it takes.
- "Context" meant both injected services and the flowing data — resolved: **Context** = injected services; **Payload** = flowing data.
- "Trace" meant both an observability span and the miner-bound execution record — resolved: bare **Trace** = the miner-bound record; the span is "span context" and stays out of the glossary as generic.
- "Trigger" was used loosely for Cue, Binding, and the event — resolved: banned as a noun; use **Cue** / **Binding** / **cue.fired**.
- A **Tree** is really a DAG (cycle detection exists) — "Tree" is historical; resolved: keep the name **Tree** / **Tree Runner** rather than renaming to Graph.
- "A Primitive is a Composition primitive or a Control primitive" no longer covers every Primitive: agent, tribunal, governed and research neither wrap a sub-pipeline nor only alter control flow — they do work through a model or the fleet. UNRESOLVED — a third kind (model-backed primitive?) is not named yet.
- **Transport** has two candidate owners: pulse's `packages/transport/` (2026-04-04 decision, predates myelin) vs myelin's L2 Transport layer. UNRESOLVED — pending ADR. Pulse owns its abstraction today; may converge on myelin later.
