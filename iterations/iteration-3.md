# Iteration 3: Flow Orchestration & Ecosystem Integration

**Status:** Not started
**Scope:** Connect pulse to the rest of the metafactory ecosystem — miner traces, arc packages, and the Flow primitive.

---

## Features

### P-300: Flow primitive with scheduling
- [ ] `Flow` type: source → pipeline → destination on a schedule
- [ ] Source adapters: RSS, webhook, file watch, API poll
- [ ] Destination adapters: file, API, email, webhook
- [ ] Cron scheduling (or integration with external scheduler)
- [ ] Flow YAML definition format

### P-301: D/A/H step classification
- [ ] Read step type from miner's trace classification (Deterministic / Agentic / Human-gate)
- [ ] **D steps:** execute automatically, no intervention
- [ ] **A steps:** delegate to an agent (Claude Code session or subagent)
- [ ] **H steps:** pause execution, emit event, wait for human approval
- [ ] Resume from H-gate after human input

### P-302: Trace emission (JSONL)
- [ ] Every execution emits structured JSONL events
- [ ] Format compatible with miner's capture ingestion (M-101)
- [ ] Events: beat-start, beat-complete, beat-failed, pulse-complete
- [ ] Include timing, input/output snapshots, retry history
- [ ] Configurable: opt-in per pipeline, redaction rules for sensitive data

### P-303: Arc package integration
- [ ] Discover arc-installed packages as available actions
- [ ] Load skill/tool capabilities from `pai-manifest.yaml`
- [ ] Map package capabilities to pulse action contracts
- [ ] `pulse actions` CLI to list available actions from installed packages

---

## Ecosystem crossover

This iteration is where pulse becomes a team player:

```
miner:M-103 (trace classification) ──► P-301 (D/A/H execution)
miner:M-101 (JSONL ingestion)      ◄── P-302 (trace emission)
arc:A-101 (install pipeline)       ──► P-303 (load installed packages)
cortex:C-102 (bus runtime)         ◄── P-302 (execution events)
```

### Integration notes (from the cortex perspective — formerly Grove)

**Event bridging priority:** P-302's JSONL trace events (beat-start, beat-complete, beat-failed, pulse-complete) map directly to what cortex surfaces. Design the event schema with bus consumption in mind — these signals enable real-time pipeline monitoring in Mission Control and Discord/Mattermost without Pulse needing to know about those destinations.

**Arc → Pulse trigger path:** Cortex already integrates with Arc for agent upgrades. P-303 should consider that cortex may trigger Pulse executions on behalf of agents — the API surface should support programmatic invocation, not just CLI.

**Self-improving feedback loop:** The Miner → Pulse → Miner cycle (P-302 feeding traces back to M-101) is the highest-value integration. Each execution refines the process patterns that generated it. Prioritize trace fidelity — include timing, input/output snapshots, and retry history so Miner has rich data to work with.

## Exit Criteria

- [ ] Flow YAML defines source → pipeline → destination
- [ ] D steps auto-execute, A steps delegate, H steps pause
- [ ] Execution JSONL can be ingested by `miner import`
- [ ] `pulse actions` lists capabilities from arc-installed packages
