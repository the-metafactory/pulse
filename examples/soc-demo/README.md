# SOC Demo — Mattermost Pulse Composer

Live composition of SOC processes on stage, driven from Mattermost
(design: `design/soc-demo-mm-composer.md`, tracking: issue #37).

A volunteer posts a security scenario into a thread; the **Pulse Composer**
replies with pipeline YAML (per-step sovereignty annotations `D|A|H` +
residency), a Mermaid diagram, and a one-line summary. The operator acks
("run it"), the flow executes, each step posts a thread reply, the final
artifact lands in-thread. Target: ~2 minutes ack → artifact.

## Pieces

| Piece | File | Role |
|---|---|---|
| Block palette | `blocks/` (19 blocks) | Stub-safe building blocks — every external adapter returns canned fixtures when its env key is unset |
| Validator | `lib/validate-pipeline.ts` + `blocks/A_VALIDATE_FLOW/` | Deterministic compose→execute gate: catalog-is-truth, required inputs, sovereignty annotations |
| Catalog | `lib/catalog.ts` + `tools/catalog.ts` | `action.json` scan; the composer prompt's source of truth |
| Composer | `composer/compose.ts` + `composer/SYSTEM_PROMPT.md` | scenario + catalog + LLM → `{ yaml, mermaid, summary }`; validator-retry loop (max 2) → closest-match fallback |
| Renderer | `composer/mermaid.ts` | Mermaid → PNG via pinned `bunx @mermaid-js/mermaid-cli@11`; any failure falls back to posting the source |
| Wiring | `run-demo.ts` + `lib/mm.ts` | compose → re-validate (fail-closed) → ack gate → run with per-step thread replies |
| Rehearsal | `rehearse.ts` | All 8 design-§9 scenarios end-to-end |

## Running

```bash
# Fully offline (stub LLM, console thread, stdin ack):
bun examples/soc-demo/run-demo.ts "credential leak at a member university"

# Real composer (needs ANTHROPIC_API_KEY):
ANTHROPIC_API_KEY=... bun examples/soc-demo/run-demo.ts "..."

# Against Mattermost (cortex stack owns the bot identity — ask JC):
MATTERMOST_URL=... MATTERMOST_BOT_TOKEN=... MATTERMOST_CHANNEL_ID=... \
  bun examples/soc-demo/run-demo.ts "..."

# Rehearse all 8 scenarios:
bun examples/soc-demo/rehearse.ts
```

## Rehearsal results — 2026-06-11, stub mode (wiring smoke)

| # | Scenario | Outcome | Steps run | Wall clock |
|---|----------|---------|-----------|------------|
| 1 | CERT advisory impact | complete | 2 | <0.1s |
| 2 | Credential leak | complete | 2 | <0.1s |
| 3 | Suspicious login | complete | 2 | <0.1s |
| 4 | DMCA abuse mail | complete | 2 | <0.1s |
| 5 | Shadow IT exposure | complete | 2 | <0.1s |
| 6 | Typosquat brand abuse | complete | 2 | <0.1s |
| 7 | Scanner traffic | complete | 2 | <0.1s |
| 8 | FADP breach notice | complete | 2 | <0.1s |

Stub mode proves the wiring path (compose → validate → ack → execute →
per-step replies → final artifact) — the stub LLM emits one deterministic
D-only flow, so composer quality is **not** exercised here. The
prompt-tuning rehearsal (`ANTHROPIC_API_KEY` set, same command) is the
pre-stage step; disposition rule per design §8.7: failures are composer
prompt bugs first, palette additions only when the scenario is likely live.

Scenario 8 (FADP 72h timer) uses no timer primitive in the demo — the
gate-before-send carries it; Reflex stays a tease (design §1, §10 Q3).

## Open items before stage

- Composer MM bot identity — JC provisions on the cortex stack (design §10 Q1; do not touch `cortex.yaml`).
- Real-LLM rehearsal of all 8 scenarios + results table refresh.
- Whois / MISP real credentials (stub-safe until then, §10 Q2).
- Backup recording of one canonical run during rehearsal (§10 Q4).
