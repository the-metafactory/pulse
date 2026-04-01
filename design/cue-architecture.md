# Cue Architecture — Design Document

**Date:** 2026-04-01
**Status:** Draft — decided in council + red team session
**Context:** Discord discussion between JC, Andreas, Ivy, Luna

---

## Decision: Cues Are Standalone Artifacts

Cues are **not** embedded in process manifests. They are a standalone artifact type (`type: cue`) in the metafactory manifest schema, fully decoupled from the processes they trigger.

### Three-Artifact Model

| Artifact | Lives In | Purpose |
|----------|----------|---------|
| **Cue** | metafactory registry | Declares the activation condition (event match, schedule, state threshold, intent pattern) |
| **Binding** | metafactory registry | Connects a cue to a process target with capability grants and priority |
| **Process** | metafactory registry | Executes without knowledge of what triggered it |

### Why Standalone (Not Embedded)

1. **Cross-publisher composability** — A community contributor can publish a cue that binds to an official process without modifying the original manifest.
2. **Fan-out / fan-in** — One cue can trigger many processes; many cues can trigger one process. Embedded cues can't express this without duplication.
3. **Late binding > early binding** — Composability demands late binding. Embedding cues in manifests is early binding disguised as simplicity.
4. **Observability** — "What fires on calendar events?" is a registry query, not a scan of every manifest.
5. **Every successful event architecture decoupled triggers** — Lambda, EventBridge, Kubernetes operators.

### Where Each Concern Lives

```
┌─────────────────────────────────────────────────────────┐
│ metafactory (registry)                                  │
│   • Cue artifact type definition (DD-26 extension)      │
│   • Cue manifest schema (type, condition, metadata)     │
│   • Binding artifact (cue → process linkage)            │
│   • Publishing, trust, signing — same as all artifacts  │
└──────────────────────┬──────────────────────────────────┘
                       │ arc installs
                       ▼
┌─────────────────────────────────────────────────────────┐
│ arc (package manager)                                   │
│   • Resolves cue artifacts (provides.cues support)      │
│   • Installs cue + binding + process as dependency set  │
└──────────────────────┬──────────────────────────────────┘
                       │ pulse discovers
                       ▼
┌─────────────────────────────────────────────────────────┐
│ pulse (execution engine) ← EVALUATOR LIVES HERE         │
│   • Cue evaluator: watches for conditions, fires cues   │
│   • Binding resolver: maps fired cue → target process   │
│   • Process executor: runs the triggered process        │
│   • Trace emission: cue.fired events in JSONL           │
└──────────────────────┬──────────────────────────────────┘
                       │ events flow to
                       ▼
┌─────────────────────────────────────────────────────────┐
│ grove (event relay)                                     │
│   • cue.fired event in event taxonomy                   │
│   • Relays cue events to Discord/dashboards             │
│   • Can programmatically fire cues on behalf of agents  │
└──────────────────────┬──────────────────────────────────┘
                       │ traces feed back to
                       ▼
┌─────────────────────────────────────────────────────────┐
│ miner (process mining)                                  │
│   • Captures cue.fired traces                           │
│   • Cue provenance: which cue triggered which process   │
│   • Suggests new cue candidates from observed patterns  │
└─────────────────────────────────────────────────────────┘
```

### Summary: Where Cues Live

| Question | Answer |
|----------|--------|
| Where is a cue **defined**? | metafactory registry — as a 9th artifact type |
| Where is a cue **installed**? | Local filesystem via arc |
| Where is a cue **evaluated and fired**? | Pulse — the cue evaluator subsystem |
| Where is a cue **relayed**? | Grove — cue.fired events in the event taxonomy |
| Where is a cue **observed**? | Miner — cue provenance in execution traces |

### Cue Types (Initial Set)

Start with core types, earn the rest through proven need:

1. **Event cue** — fires when a matching event appears (e.g., `grove.tool_call`, `git.push`)
2. **Schedule cue** — fires on a time schedule (cron expression)
3. **State cue** — fires when a state condition is met (e.g., "all tests pass", "PR merged")

Deferred until proven need:
- Intent cue (natural language pattern match)
- Compound cue (boolean combination of other cues)
- Threshold cue (metric crosses boundary)

### Security Model

Security lives at the **binding**, not the cue:
- Signed capability chains at bind time
- Lightweight verification at fire time
- A cue without a binding is inert — observable but harmless

### Relationship to Existing Pulse Features

| Feature | Relationship to Cues |
|---------|---------------------|
| P-300 (Flow) | Flows already have sources — cues become a new source type |
| P-301 (D/A/H) | Cue-triggered processes still respect D/A/H classification |
| P-302 (Traces) | cue.fired events are a new trace type |
| P-401 (Grove bridge) | Natural relay point for cue.fired events |

### Blueprint Features

See meta-factory blueprint C-100 through C-103 and grove G-600 for the implementation roadmap.

---

## Red Team Verdict

The red team steelmanned the embedded position (8 arguments) and demolished it with 8 counter-arguments. The knockout: **composability demands late binding; embedding cues in manifests is early binding disguised as simplicity.**

Full debate record in Discord (#general, 2026-04-01).
