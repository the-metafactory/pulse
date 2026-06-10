# SOC Containment Tribunal — realistic L1 governance demo

The next chapter after [`examples/soc-triage/`](../soc-triage/): the advisory
recommended *"block both domains"* — now someone has to decide. This demo runs
that decision through the governed-action stack with a real bus, real
envelopes, and a simulated fleet you can swap for a real one.

```
L0  enforcement gate    deterministic policy rules the request:  ask
L1  tribunal:           three model-diverse fleet seats vote over the bus,
                        the Honest Oracle breaks splits → allow / deny / defer
L2  human gate          only a defer would reach a person
                        (the in-pipeline composition is Stage 4 / P-702 —
                         here L0 runs as a prelude and defer halts fail-closed)
```

## Run it

```bash
bun examples/containment-tribunal/run-demo.ts              # ALLOW — diverse confident majority
bun examples/containment-tribunal/run-demo.ts --split      # DENY — panel splits, Honest Oracle tiebreaks
bun examples/containment-tribunal/run-demo.ts --degraded   # DENY — fleet majority offline, fail-closed
bun examples/containment-tribunal/run-demo.ts --protected  # DENY at L0 — tribunal never convenes, zero LLM cost
bun examples/containment-tribunal/run-demo.ts --llm        # real models: Ollama (local seat), claude CLI (frontier seats)
bun examples/containment-tribunal/run-demo.ts --live       # real NATS bus on localhost:4222
bun examples/containment-tribunal/run-demo.ts --live --no-fleet   # a real cortex fleet claims the seats
```

Watch the envelopes on a live bus:

```bash
nats sub 'local.switch-soc.>'
```

## The panel

| Seat | Capability | Lens | model_class |
|------|-----------|------|-------------|
| `network` | `containment.review.network` | blast radius, collateral, reversibility | `frontier` |
| `intel` | `containment.review.intel` | confidential resolver telemetry — active harm? | `local-only` |
| `provenance` | `containment.review.provenance` | is the request itself attacker-induced? | `any` |
| `oracle` (tiebreaker) | `review.adversarial` | attacks both positions, rules on the survivor | `frontier` |

Sovereignty is still the plot: the member-confidential resolver telemetry
appears **only** in the `intel` seat's prompt (`model_class: local-only`,
`frontier_ok: false`) — frontier seats argue from the sanitized summary. The
fleet enforces this consumer-side: a frontier agent receiving a local-only
envelope refuses it on the bus, visibly.

The three seats declare three distinct model classes, so the diversity rule
(Gate 22) passes without reassignment — and each vote carries its executing
model for the post-hoc check (two allowing seats reporting the same model
downgrade an allow to defer).

## What each scenario proves

- **default (ALLOW)** — robust majority (`allows > denies + abstains`) over
  the 0.6 confidence bar → `out/blocklist.json` written, full verdict appended
  to `out/audit.jsonl` (every vote, confidence, model, the diversity record).
- **`--split` (DENY)** — intel dissents (rotation risk before account resets),
  panel ties 1-1-1, the Honest Oracle is convened, attacks both positions, and
  denies. Majority deny → StepFailure; nothing is blocked, nothing written.
- **`--degraded` (DENY)** — two of three review agents are offline; their
  seats time out into abstains. 1 allow / 0 deny / 2 abstain is an
  *incapacitated panel* → deny, fail-closed. (One dead seat would NOT block:
  2 allow / 1 abstain is still a robust majority — resilience and fail-closed
  in the same math.)
- **`--protected` (DENY at L0)** — the request targets `sso.switch.ch`, a
  protected zone. The deterministic gate refuses before any agent is consulted:
  no panel, no tokens, nothing to clean up.

## How it relates to the other examples

- [`examples/tribunal/`](../tribunal/) — minimal scripted intro to the
  tribunal API (no bus, no fleet). Start there for the aggregation semantics.
- [`examples/soc-triage/`](../soc-triage/) — the upstream story: triage →
  advisory. This demo consumes that advisory's recommendation.
- Stage 4 (P-702) composes the full stack in one pipeline: L0 as a policy on
  the containment capability, `ask` routed to this tribunal, `defer` routed to
  an analyst `gate:`. Design: `docs/verdict-tribunal.md`,
  `docs/governance-upgrade-plan.md` (PR #28).

## Files

```
containment-tribunal/
  pipeline.yaml             P_CONTAINMENT — parse → tribunal → execute → audit
  policy.json               L0 rules: protected zones deny, sinkhole allows, rest asks
  run-demo.ts               L0 prelude + transport/fleet wiring + event rendering
  fleet-sim.ts              4 review agents speaking the cortex dispatch contract
  fixtures/containment-request.json   synthetic request (no real personal data)
  A_PARSE_REQUEST/          validate + derive blast radius (D)
  A_EXECUTE_CONTAINMENT/    write the blocklist artifact (D, writeFile)
  A_RECORD_AUDIT/           append-only audit of the full verdict (D)
  out/                      blocklist.json + audit.jsonl (gitignored)
```
