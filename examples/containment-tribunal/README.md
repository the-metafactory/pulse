# SOC Containment — the governed-action stack, live

The next chapter after [`examples/soc-triage/`](../soc-triage/): the advisory
recommended *"block both domains"* — now someone has to decide. Since Stage 4
(P-702) the whole decision runs **in-pipeline** as one `governed:` step:

```
L0  policy (evaluate)   allow → proceed, panel skipped (zero LLM cost)
                        deny  → halt · ask ↓
L1  tribunal            three model-diverse fleet seats vote over the bus,
                        the Honest Oracle breaks splits; deny halts · defer ↓
L2  analyst gate        pass → proceed · fail → halt
```

**Refusals are terminal at every layer — only uncertainty travels down.**
A tribunal deny never reaches the analyst; only its *defer* does. Every
layer's verdict is published to the bus as `governance.verdict.*` envelopes —
the audit trail Stage 5 reads back.

## Run it

```bash
bun examples/containment-tribunal/run-demo.ts                # ALLOW at L1 — diverse confident majority
bun examples/containment-tribunal/run-demo.ts --preapproved  # ALLOW at L0 — sinkhole target, panel never convenes
bun examples/containment-tribunal/run-demo.ts --protected    # DENY at L0 — protected zone, zero LLM cost
bun examples/containment-tribunal/run-demo.ts --split        # DENY at L1 — panel splits, Honest Oracle tiebreaks
bun examples/containment-tribunal/run-demo.ts --degraded     # DENY at L1 — fleet majority offline, fail-closed
bun examples/containment-tribunal/run-demo.ts --defer        # ALLOW at L2 — low-confidence panel defers to the analyst
bun examples/containment-tribunal/run-demo.ts --defer --interactive   # type the analyst verdict yourself
bun examples/containment-tribunal/run-demo.ts --llm          # real models: Ollama (local seat), claude CLI (frontier seats)
bun examples/containment-tribunal/run-demo.ts --live         # real NATS bus on localhost:4222
bun examples/containment-tribunal/run-demo.ts --live --no-fleet   # simulator off — seat subjects left free for an external fleet you run
```

Watch the envelopes — seat tasks, dispatch lifecycle, AND layer verdicts —
on a live bus:

```bash
nats sub 'local.switch-soc.>'
```

## The panel (L1)

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
envelope refuses it on the bus, visibly. Three distinct declared classes
satisfy the diversity rule; every vote carries its executing model for the
post-hoc check.

## What each scenario proves

- **default (ALLOW at L1)** — L0 says `ask`, the panel rules a robust majority
  over the 0.6 confidence bar → `out/blocklist.json` + the full multi-layer
  record in `out/audit.jsonl`.
- **`--preapproved` (ALLOW at L0)** — the target matches the sinkhole-test
  pattern; policy pre-approves and the panel never convenes. Zero seats
  dispatched, zero tokens.
- **`--protected` (DENY at L0)** — the request targets `sso.switch.ch`; the
  deterministic gate refuses before any agent is consulted.
- **`--split` (DENY at L1)** — intel dissents, panel ties 1-1-1, the Honest
  Oracle attacks both positions and denies. Refusal is terminal — the analyst
  is never asked to overrule it.
- **`--degraded` (DENY at L1)** — two of three review agents are offline;
  their seats time out into abstains. 1 allow / 0 deny / 2 abstain is an
  *incapacitated panel* → deny, fail-closed. (One dead seat would NOT block:
  2 allow / 1 abstain is still a robust majority.)
- **`--defer` (ALLOW at L2)** — unanimous allow at low confidence (mean 0.45
  < bar 0.6): the panel won't own the call and defers. The analyst gate opens
  carrying the defer reason; pass applies the block, fail refuses. This is
  the only path that spends human attention — by construction.

## How it relates to the other examples

- [`examples/tribunal/`](../tribunal/) — minimal scripted intro to the
  tribunal API (no bus, no fleet). Start there for the aggregation semantics.
- [`examples/soc-triage/`](../soc-triage/) — the upstream story: triage →
  advisory. This demo consumes that advisory's recommendation.
- Design: `docs/verdict-tribunal.md` (tribunal + `governed:` composition),
  `docs/governance-upgrade-plan.md` (PR #28). Stage 5 adds the Mission
  Control tab that reads `governance.verdict.*` back off the bus.

## Files

```
containment-tribunal/
  pipeline.yaml             P_CONTAINMENT — parse → governed (L0+L1+L2) → execute → audit
  run-demo.ts               transport/fleet wiring, event rendering, bus verdict publishing
  fleet-sim.ts              4 review agents speaking the cortex dispatch contract
  fixtures/containment-request.json   synthetic request (no real personal data)
  A_PARSE_REQUEST/          validate + derive blast radius (D)
  A_EXECUTE_CONTAINMENT/    write the blocklist artifact (D, writeFile)
  A_RECORD_AUDIT/           append-only audit of every layer's verdict (D)
  out/                      blocklist.json + audit.jsonl (gitignored)
```
