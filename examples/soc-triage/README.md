# CommunitySOC Phishing Triage — agentic flow demo

A pulse pipeline mixing **deterministic actions**, **fleet agents** (LLM tasks
via myelin envelopes), and a **human gate** — with sovereignty routing keeping
confidential member data on local models while shareable IOCs go to a frontier
model.

```
reported email ──► agent: triage ──► A_SANITIZE_IOCS ──► agent: enrich ──► gate ──► A_PUBLISH_ADVISORY ──► A_NOTIFY_MATTERMOST
(confidential)     local-only LLM    strips member PII   frontier model    analyst   community advisory     post to channel
                   frontier_ok:false (sovereignty         frontier_ok:true verdict                          (skips when unset)
                                      boundary)
```

## Run it

```bash
# Offline, deterministic (in-memory bus, simulated fleet, canned model answers)
# Analyst gate auto-passes by default.
bun examples/soc-triage/run-demo.ts

# Interactive analyst gate (type verdict + notes at the pause)
bun examples/soc-triage/run-demo.ts --interactive

# Real models: Ollama (local agent) + claude CLI (frontier agent)
bun examples/soc-triage/run-demo.ts --llm

# Real NATS bus on localhost:4222 (bun add nats first; NATS_URL to override)
bun examples/soc-triage/run-demo.ts --live

# Real bus + real cortex fleet claims the tasks (no simulator)
bun examples/soc-triage/run-demo.ts --live --no-fleet

# Show sovereignty ENFORCEMENT: raw email offered to the frontier → refused
bun examples/soc-triage/run-demo.ts --violate
```

## Mattermost notification (optional)

The final step posts the approved advisory to a Mattermost channel via a bot
account. Without config the step logs a skip and passes through — every run
mode above stays offline-safe.

```bash
cp examples/soc-triage/.env.example examples/soc-triage/.env
# edit .env: MATTERMOST_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_CHANNEL_ID
# (channel ID, not channel name; the demo .env is gitignored)

bun examples/soc-triage/run-demo.ts
```

Environment variables take precedence over the demo `.env`. The SWITCH demo
uses the Sage bot on `securechat-test.switch.ch` (VPN required).

When configured, a failed post fails the pipeline — a SOC that believes it
notified members but didn't is worse than a visible error.

## NetSecWG demo script (~5 min)

**Setup (before the talk):** `nats-server` running, `ollama pull llama3.2`,
three terminal panes.

1. **Pane 1 — the bus is glass:** `nats sub 'local.switch-soc.>'`
   Everything that follows is visible here: task envelopes, lifecycle events,
   sovereignty blocks in plain JSON.

2. **Pane 2 — show the pipeline, not code:** `cat examples/soc-triage/pipeline.yaml`
   Talk track: *"Three kinds of steps. Plain strings run deterministic
   TypeScript. `agent:` hands work to whatever agent on the bus claims the
   capability. `gate:` pauses for a human. Deterministic / Agentic / Human —
   the whole agentic-OS taxonomy is five YAML keywords."*

3. **Pane 3 — run it live:** `bun examples/soc-triage/run-demo.ts --live --llm --interactive`
   Talk track while it runs: *"The raw phishing mail contains member data — the
   envelope says `model_class: local-only`, so it's analyzed by Ollama on this
   laptop. A deterministic action strips PII. Only then do the IOCs — now
   shareable — go to a frontier model for enrichment. And nothing leaves the
   SOC until the analyst says so."* Type the gate verdict live.

4. **The punchline:** `bun examples/soc-triage/run-demo.ts --live --violate`
   Watch pane 1: the frontier agent **refuses** the raw email because the
   envelope demands local-only. *"The policy travels with the data. The fleet
   enforces it. That's sovereignty as infrastructure, not as a compliance
   document."*

**Fallback:** if WiFi/NATS/Ollama dies, drop `--live --llm` — the identical
pipeline and envelopes run on the in-memory bus with canned model answers.
The demo cannot fail.

## Other CommunitySOC flow ideas this pattern unlocks

- **Alert storm compressor** — `map:` local LLM over XDR alerts (tenant data),
  `filter:` by severity, frontier clusters the sanitized summaries into campaigns.
- **Multilingual IR comms** — local model drafts facts, `parallel:` frontier
  branches produce DE/FR/IT/EN member notifications.
- **CERT advisory reflexer** — public advisories rated by frontier, matched
  against confidential member sector profiles by a local model (the split inverted).
- **Hunt hypothesis loop** — frontier proposes hunts from public TTPs, local
  agent runs KQL against tenant logs, only aggregate stats flow back.
