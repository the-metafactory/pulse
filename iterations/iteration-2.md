# Iteration 2: Pipe Model & Action Contract

**Status:** Not started
**Scope:** Transform pulse from a generic task runner into a process execution engine with the pipe model from PAI's Arbol vision.

---

## Features

### P-200: Typed Action contract
- [ ] Define `Action<TInput, TOutput>` interface with typed input/output
- [ ] Action metadata: id, name, description, capabilities required
- [ ] Align with `pai-manifest.yaml` capability declarations (what arc understands)
- [ ] Action registry with type-safe lookup
- [ ] Backward-compatible with current `(context) => Promise<any>` registration

### P-201: Passthrough pipe model
- [ ] Replace `ExecutionContext.parentResults` Map with accumulating data object
- [ ] Each action receives `{...allUpstreamData}` and returns `{...upstream, ...myFields}`
- [ ] Final action has access to every field from every ancestor — not just direct parents
- [ ] Type inference for accumulated context through pipeline stages

### P-202: Pipeline primitive
- [ ] First-class `Pipeline` type: ordered list of Actions
- [ ] Declarative definition (YAML or JSON):
  ```yaml
  name: P_LABEL_EMAIL
  actions: [A_EXTRACT, A_LABEL, A_SEND_EMAIL]
  ```
- [ ] Pipeline runner that chains actions with pipe model
- [ ] Validation: all referenced actions exist, types align

### P-203: Process YAML loader
- [ ] Accept miner's composed process YAML as pipeline input
- [ ] Map miner's D/A/H step types to pulse action types
- [ ] Resolve action references to registered implementations
- [ ] Cross-dependency: requires miner:M-301 (process composition) to define the format

---

## Execution Order

```
P-200 (Action contract)
  └─► P-201 (pipe model)
        └─► P-202 (Pipeline primitive)
              └─► P-203 (process YAML loader) — also needs miner:M-301
```

## Key design decisions

**Backward compatibility:** The current `registerAll({ id: async (ctx) => ... })` API must keep working. The typed Action contract is an opt-in upgrade for new code.

**Pipe model vs tree model:** The pipe model (linear chain) and tree model (dependency DAG) coexist. Pipelines use the pipe model; complex workflows use the tree runner. A Pipeline is syntactic sugar over a linear tree with the passthrough pattern.

## Exit Criteria

- [ ] Typed Action contract with backward-compatible registration
- [ ] Pipe model accumulates data through pipeline stages
- [ ] Pipeline YAML loads and executes correctly
- [ ] Integration test: define pipeline in YAML, register actions, run, verify accumulated output
