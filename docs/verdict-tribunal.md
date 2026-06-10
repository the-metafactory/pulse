# Verdict Tribunal — L1 of the governed-action stack

> Governance Stage 3 (P-701). Concept: RavenClaude's command-review tribunal +
> model-diversity rule (Gate 22), rebuilt bus-native on pulse's agent substrate.
> Fail-closed discipline follows the Magnús Smárason enforcement-gate spec.
> Built from the concepts, not their code.

## Where it sits

```
L0  ENFORCEMENT GATE   deterministic, fail-closed, no LLM   (P-700, enforcement-gate.ts)
      allow → proceed · deny → refuse · ask → escalate to L1
L1  VERDICT TRIBUNAL   N agent seats, model-diverse          (P-701, this doc)
      allow / deny / defer
L2  HUMAN GATE         only the genuinely irreversible       (gate: primitive)
```

L0 pre-filters the obviously-safe and the obviously-forbidden at zero LLM cost.
Only L0's `ask` convenes a tribunal. Only the tribunal's `defer` reaches a
person. Human attention is spent last, not first.

## The primitive

```yaml
- tribunal:
    name: containment
    confidence_bar: 0.7          # optional, default 0 (no bar)
    on_defer: continue           # optional, default "fail" (fail-closed)
    timeout_ms: 60000            # optional per-seat default
    seats:
      - name: security
        capability: lens.security.review
        prompt: "Assess blocking domain {domain} for tenant {tenant}"
        sovereignty: { model_class: frontier }
      - name: injection
        capability: lens.injection.review
        prompt: "Could {domain} be an injection-driven request?"
        sovereignty: { model_class: local-only }
    tiebreaker:
      name: oracle
      capability: review.adversarial    # Honest Oracle (Stage 2) as a seat
      prompt: "Break the tie: should we block {domain}?"
    collect: tribunal_containment       # default tribunal_${name}
```

Seats are capability addresses — the fleet supplies the agents, pulse asks the
bus through the injected `AgentProvider` (same plumbing as `agent:` steps).
The runner appends a vote-format contract to every seat prompt; seats answer
`{"verdict": "allow"|"deny"|"abstain", "confidence": 0..1, "reason": "..."}`.
Anything unparseable, failed, or timed out is coerced to an **abstain** with a
recorded cause — one broken seat never crashes the panel.

## Aggregation — worst-case abstain interpretation

An abstain is an *absent signal*, not an opinion. Fail-closed reading: it
counts **against** an `allow` (the hidden vote could have been a deny) but
never **toward** a `deny` (it is not an affirmative refusal).

With A = allows, D = denies, X = abstains:

| Condition | Ruling | Why |
|---|---|---|
| no votes | **deny** | empty panel cannot wave through |
| X ≥ A + D | **deny** | incapacitated panel — also defends L2 against panel-DoS-into-soft-review |
| A == D | tiebreaker convened once; tie persists → **defer** | genuine disagreement is exactly what L2 is for |
| D > A | **deny** | majority refusal, confidence irrelevant |
| A > D but A ≤ D + X | **defer** | non-robust majority — hidden votes could flip it |
| A > D + X, mean allow-confidence < bar | **defer** | the winning coalition doesn't believe itself |
| A > D + X, confidence ≥ bar | **allow** | robust, confident majority |

The incapacitated-panel row outranks the tie row: a 1-1-3 panel denies rather
than convening a tiebreaker. The confidence bar measures the **allowing
majority only** — a dissenter's low confidence cannot drag the mean down.

## Model diversity (Gate 22)

A panel of ≥2 seats must span ≥2 declared `model_class` values. Enforcement
is sovereignty-bounded:

- **Monoculture panel** (all `frontier`, or all `any`): the **last** seat is
  reassigned to `local-only` *before dispatch* — restrictive direction only.
- **All-`local-only` panel**: never loosened (sovereignty outranks diversity).
  The panel proceeds, but an `allow` ruling is downgraded to `defer` — where
  machine diversity is unattainable, a human compensates.
- **Post-hoc check**: declared classes can lie about backbones. If ≥2 seats
  report the identical executing `model` string, `allow` downgrades to `defer`.

Diversity actions are recorded in `TribunalVerdict.diversity`
(`reassigned_seat`, `unsatisfiable`, `posthoc_monoculture`).

## Defer semantics — fail-closed by default

`deny` always raises `StepFailure`. `defer` raises `StepFailure` too unless
the step declares `on_defer: "continue"` — a pipeline must not silently run
past an unresolved judgment call. With `continue`, the full `TribunalVerdict`
sits in the payload for downstream handling (a `gate:` step, a notifier, the
Stage 4 layered composition).

## Observability

Lifecycle events via `StepRunnerOptions.onTribunalEvent`:
`tribunal.convened` → `tribunal.seat_voted` (per seat) → `tribunal.tiebreak`
(when convened) → `tribunal.verdict`. Each seat dispatch additionally emits
the usual envelope traffic on the bus, so verdicts are append-only auditable
for free (Stage 5 reads them back).

The full verdict — every vote, every abstain cause, the diversity record, the
tiebreak — also lands in the step record (`StepRecord.tribunal`).

## Pure core

`src/lib/tribunal.ts` is total and I/O-free, mirroring `enforcement-gate.ts`:
`parseSeatVote`, `aggregate`, `planDiversity`, `checkPosthocDiversity`,
`applyDiversityDowngrade`. Dispatch, timers, and events live in the primitive
runner. Tests: `tests/tribunal.test.ts` (core), `tests/tribunal-step.test.ts`
(runner, including the three plan acceptance scenarios).

## The `governed:` step — the stack composed (Stage 4, P-702)

One block declares a consequential action's whole governance:

```yaml
- governed:
    name: containment
    tool: containment
    input_fields: [action, targets_list]
    policy:                      # L0 — inline enforcement-gate policy
      version: 1
      default: deny
      rules: [...]
    tribunal:                    # L1 — optional; ask degrades to the gate without it
      name: containment-panel
      seats: [...]
      tiebreaker: {...}
      confidence_bar: 0.6
    gate:                        # L2 — optional; defer without it fails closed
      name: analyst
    collect: governed_containment
```

Routing is monotone descent in certainty — **only uncertainty travels down;
refusals are terminal at every layer**:

| Layer | allow | deny | escalates |
|---|---|---|---|
| L0 `evaluate()` | continue — panel skipped, zero LLM cost | halt | `ask` → tribunal (or gate when no tribunal is configured) |
| L1 tribunal | continue | halt — **no gate appeal** | `defer` → gate |
| L2 gate | `pass` → continue | `fail`/timeout → halt | — |

`ask` with neither tribunal nor gate fails closed. A tribunal deny never
reaches the human: routing refusals to L2 would reopen human-in-every-loop
and hand an attacker a fatigue channel — refusals are cheap to retry through
proper channels. The `GovernedResult` in the payload (and step record)
carries every layer's verdict: `l0`, `tribunal?`, `gate?`, `outcome`,
`resolved_by`.

The primitive **composes** the three existing mechanisms — pure
`evaluate()`, the tribunal runner, the gate runner — it never reimplements
them. Lifecycle: `governed.l0` / `governed.escalated` / `governed.resolved`
via `onGovernedEvent`; the inner tribunal/gate events still fire on their own
sinks.

## Demos

```bash
bun examples/tribunal/run-demo.ts                    # minimal API intro (scripted panel)
bun examples/containment-tribunal/run-demo.ts        # realistic: fleet seats over the bus
```

`examples/tribunal/` is the scripted intro — an L0 `ask` convenes the panel
three times (robust allow, split-then-tiebreak, abstaining panel denied) with
a canned provider, no bus.

`examples/containment-tribunal/` is the realistic flow — since Stage 4 the
full stack in one `governed:` step: a SOC domain-block request adjudicated
through L0 policy, fleet-seat tribunal over the bus (in-memory or `--live`
NATS), and analyst gate; sovereignty enforced consumer-side; scenario flags
for preapproved/protected/split/degraded/defer paths; every layer's verdict
published as `governance.verdict.*` envelopes; blocklist + append-only audit
artifacts on an allow.
