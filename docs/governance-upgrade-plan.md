# Governance Upgrade Plan — Magnus × RavenClaude × metafactory

_Draft 2026-06-10, status updated 2026-06-11 · synthesises two external inputs into a staged build plan for the metafactory ecosystem (pulse · cortex · compass · arc)._

> **Status (2026-06-11):** Stages 1, 1b, 2, 3, 4, 5, 6 are **shipped and deployed**; Stage 8's standard is shipped (compass v0.10.0) and its reply is drafted+held at the human gate — pulse v0.12.0 (enforcement gate P-700, verdict tribunal P-701, governed-action stack P-702 + containment demo), cortex sovereignty gate (audit-parity), sage Honest Oracle lens v0.2.6. Stage 7 (lessons loop) remains; Stage 8's reply awaits a human send. Per-stage annotations below.

## The convergence

Three systems, built independently, arrived at the same thesis: **governance is executable infrastructure, not documentation.** The shape they share:

| Principle | Magnus (Sumarhús) | RavenClaude | metafactory today |
|---|---|---|---|
| Declarations must be **enforced**, not trusted | enforcement gate (`evaluate → allow/ask/deny`, fail-closed) | comfort-posture → real permission rules | capability manifests + sovereignty envelopes *declare*; **nothing bites yet** — sovereignty is consumer-voluntary (Stage 1b) |
| **Human on the consequential**, agent on the reversible | operator-authorization principle | `design_checkins` decoupled from permission level | `gate:` primitive (human verdict) |
| **Adversary kept separate** from fixer | Honest Oracle persona | command-review tribunal + model diversity | `agent:` steps, no adversarial lens yet |
| **Append-only audit** | signed colophon, append-only history | Sága log + Heimdall/Víðarr tabs | bus envelopes already append-only on NATS |
| **Trust is earned in rungs** | diplomatic pouch → … → live connection | n/a (single-author) | NATS leaf federation (high-trust endpoint only) |
| **Lessons compound** | skill corpus + usage telemetry | `/wrap` → scenario → best-practice promotion | miner traces (capture only; no promotion loop) |

What each is missing, the other supplies:

- **Magnus has the floor we lack** — a deterministic, fail-closed runtime gate. We have the envelope and the manifest; we never built the thing that refuses a call.
- **RavenClaude has the adjudicator above the floor** — an LLM tribunal for the `ask` tier, so "human-in-the-loop" doesn't mean "human-in-every-loop."
- **We have the substrate both lack** — a real bus, capability-addressed dispatch, cross-principal federation, sovereignty envelopes. Their hooks-and-YAML mechanisms become *bus-native flows* on our stack.

**The combined picture: a layered governed-action pipeline.**

```
        ┌─────────────────────────────────────────────────────────┐
        │  every consequential action passes top-to-bottom         │
        ├─────────────────────────────────────────────────────────┤
  L0    │  ENFORCEMENT GATE   deterministic, fail-closed, no LLM    │ ← Magnus' spec
        │   allow → proceed · deny → refuse · ask → escalate to L1  │
  L1    │  VERDICT TRIBUNAL   N agent: seats, model-diverse,        │ ← RavenClaude's Thing
        │   adversarial (Honest Oracle is a seat) → allow/deny/defer│   + Magnus' Oracle
  L2    │  HUMAN GATE         only the genuinely irreversible       │ ← our gate: primitive
        ├─────────────────────────────────────────────────────────┤
        │  every verdict → append-only on the bus (free Sága)      │
        │  → MC observability tab (Heimdall/Víðarr equivalent)     │
        └─────────────────────────────────────────────────────────┘
```

L0 pre-filters the obviously-safe (zero LLM cost) and the obviously-forbidden (fail-closed). Only L0's `ask` reaches L1. Only L1's `defer` reaches L2. The human's attention is spent last, not first.

This is one coherent capability the ecosystem does not yet have, assembled almost entirely from primitives we already shipped.

---

## The plan — 8 stages, dependency-ordered

Each stage is independently shippable and useful on its own. Later stages compose earlier ones; none requires the next. Feature IDs are proposed `P-7xx` (pulse), `C-xxx` (cortex), `COMP-xx` (compass).

### Stage 1 — Enforcement gate, deterministic core `[pulse · P-700]` ✅ SHIPPED (pulse#29, v0.9.0)
**Build Magnus' spec verbatim as a pure pulse module.** `evaluate(tool, input, policy) → {decision, reason, rule_index}`, first-match-wins, fail-closed invariants (no silent allow; errors deny; absent default = deny). No I/O, no network — a pure function with a Zod-validated `Policy` type.

- Port his `SPEC.md` fail-closed test suite verbatim as our acceptance criteria (his invariants are the spec).
- Wire as a wrapper around `createLocalCapabilities`: each injected capability (`shell`, `fetch`, `writeFile`) consults the policy before executing. A pipeline carries an optional `policy.json`; absent → deny-all for guarded tools (fail closed).
- **Ship on its own:** any pipeline can now declare a write/exec blast-radius policy. This is the missing runtime complement to capability manifests — the single highest-value, lowest-risk item in the plan.

_Acceptance:_ Magnus' invariant tests pass; a pipeline with no policy denies guarded calls; a malformed policy denies, never crashes.

### Stage 1b — Consumer-side sovereignty gate `[cortex/myelin · C-xxx]` ✅ SHIPPED audit-parity (cortex#906, v5.7.0; hard-deny waits on cortex#327)
**The same fail-closed gate, one layer down — on the bus, where the trust boundary actually is.** Today nothing bites on a *false* sovereignty claim: the envelope *declares* `model_class: local-only`, but enforcement is consumer-voluntary. Verified by reading the code (2026-06-10):

- **What enforces today:** the `peers[]` membership gate (`review-consumer.ts:577`, fail-closed, but gates the cross-principal *requester*, not task-claiming); the `signed_by` chain (cortex#327, **audit mode by default** — admit + record); envelope validation (`myelin/envelope.ts:184`, checks sovereignty fields are well-*formed*, never *true*).
- **The gap:** `model_class`/`frontier_ok` are copied into **audit** envelopes (`dispatch-listener.ts:1635, 2192`) — recorded, not checked. The only "I am frontier, this task is local-only, therefore I refuse" logic lives in the SOC demo's `fleet-sim.ts` — application-layer, voluntary. The `--violate` demo passes because the sim agent *chooses* to refuse. Task-claiming = subscribing to the subject; nothing authorises *which* consumer may claim a given sovereignty class.

**Build:** a consumer-side gate that, before running a claimed task, runs `evaluate(envelope.sovereignty, this_agent.class) → allow/deny`. A `model_class=frontier` agent claiming a `local-only` task → **deny + `nak` + emit `dispatch.task.denied`**, fail-closed (same invariants as Stage 1: absent/malformed policy denies). Deny at **claim time** (before the CC spawn), so a wrong-class agent never starts the work.

**Hard dependency — the consumer's class must be unspoofable.** Self-declared class (`cortex.yaml` agent runtime) is honest-but-spoofable. The real fix ties `model_class` to the **signing identity**: the nkey that signed the claim must belong to a registered agent of that class. So this stage **depends on signing moving audit → enforce** (cortex#327) — without it the gate checks a label the consumer writes about itself. Ship the gate in audit-parity first (deny on class mismatch using declared class, log only), then flip to hard-deny once signing enforces.

_Why it matters more here than in pulse:_ the bus *is* the trust boundary between agents and principals. Magnus' manifest-vs-gate point applies most sharply here — the envelope's sovereignty is the ecosystem's core "benevolent cage," and right now it's a cage with the door drawn on.

_Acceptance:_ a frontier-class consumer claiming a `local-only` task is denied + nak'd before spawn; the denial emits `dispatch.task.denied` on the bus; absent/malformed policy denies; with signing in `enforce`, a spoofed self-declared class cannot pass.

### Stage 2 — Honest Oracle as a review capability `[cortex · C-xxx]` ✅ SHIPPED (sage#86, v0.2.6; 7th lens, fires on every applicable review)
**Drop his pure-prompt adversarial persona in as a new review flavor** `review.adversarial` (or `code-review.adversarial`), registered in `cortex.yaml` `provided_by`. It attacks a finished artifact only — unsupported claims, surrogate endpoints, citation drift, overclaim, silent failures — and never proposes fixes (adversary stays separate from fixer).

- Reuse the sage dispatch path proven this session (`sage dispatch … --capability`).
- Verdict rides the bus as any other review verdict — append-only audit for free.
- **Ship on its own:** `pilot`/`sage` reviews gain an adversarial lens; the build-journal pipeline gains an overclaim check (the andreas-sim already refused sign-off on unverifiable claims — formalise that instinct).

_Acceptance:_ dispatching `review.adversarial` on a PR returns attack-only findings; it never edits.

### Stage 3 — Verdict tribunal as a pulse pattern `[pulse · P-701]` ✅ SHIPPED (pulse#31, v0.10.0; realistic demo pulse#33, v0.11.0)
**RavenClaude's Thing, bus-native.** A reusable sub-pipeline: `parallel:` over N `agent:` seats (security / code / injection lenses, Honest Oracle from Stage 2 as the adversarial seat) → deterministic aggregator action → `allow / deny / defer`.

- **Model-diversity rule** (their Gate 22): enforce ≥2 distinct `model_class`/model backbones when ≥2 seats convene — we already carry `model_class` in sovereignty; the aggregator refuses a monoculture panel.
- Tiered routing: low → no panel (zero cost); escalating seat count + confidence bar by tier; abstain fails **closed**.
- This is L1 of the layered picture: it consumes L0's `ask` decisions.

_Acceptance:_ a split panel convenes a tiebreaker; a same-model panel auto-reassigns one seat; an abstaining panel denies. **All three test-proven.** Build refinements: worst-case abstain aggregation (abstains count against allow, never toward deny); diversity reassignment restrictive-only (sovereignty outranks diversity; all-local-only panels downgrade allow→defer); post-hoc identical-model check on the allowing coalition.

### Stage 4 — The layered governed-action pipeline `[pulse · P-702]` ✅ SHIPPED (pulse#35, v0.12.0)
**Compose Stages 1+3+ existing `gate:` into the L0→L1→L2 stack.** A pipeline-level policy that says: deterministic gate first; its `ask` routes to the tribunal; the tribunal's `defer` routes to the human gate. One worked example end-to-end.

- **SOC demo:** tribunal adjudicates a containment action (block domain / isolate host) — L0 denies the obviously-wrong, L1 panel handles the judgment call, L2 gate only for high-blast. The fleet *is* the panel.
- Demonstrates the whole thesis as a runnable flow, not prose.

_Acceptance:_ a containment pipeline runs all three layers; each layer's verdict is on the bus. **Both proven** — `governed:` primitive (one YAML block: inline policy + tribunal + gate; routing axiom: only uncertainty travels down, refusals terminal at every layer; `ask` without a tribunal degrades to the gate); demo publishes `governance.verdict.{l0,tribunal,gate,resolved}` envelopes, live-probed over NATS.

### Stage 5 — Audit substrate + observability tab `[cortex MC · G-1115]` ✅ SHIPPED (cortex#986, v5.10.0; pulse#41 envelope conformance, v0.12.1)
**Make the verdicts visible.** Verdicts already land append-only on the bus (our free Sága). Add a read-only MC dashboard tab: recent denials + verdicts + sovereignty refusals, last 30d, tiered alarm banner, honest empty states (RavenClaude's Heimdall/Víðarr, but reading the bus instead of JSONL files).

- We already emit sovereignty refusals (`--violate` demo) — this surfaces them.
- **SOC compliance story made visible:** "every blocked action, every verdict, who approved, when."

_Acceptance:_ a tab renders the last 30d of verdicts from the bus; empty state is honest (never a fake all-clear). **Both met** — Governance tab on the MC-I1.S6 projection seam (`governance_verdicts`, idempotent on envelope id), `GET /api/governance` with deterministic alarm tiers (24h denials: 0 none / 1-4 elevated / ≥5 high), empty state honest in BOTH directions (zero rows = nothing ran OR verdicts never reached the projection). `governance` is now a documented bus domain (cortex CONTEXT.md).

### Stage 6 — Diplomatic pouch, trust rung 1 `[pulse + compass · P-703 / compass#75]` ✅ SHIPPED (pulse#45, v0.13.0; compass#75)
**Build our Gestur-equivalent from Magnus' Foreign Policy spec — do not install his zip** (matches his own philosophy: build the better-fitting version on your own substrate; and his border #1: nothing executable crosses on first contact).

- A pulse pipeline: outbound note → sanitize + whitelist (the SOC sovereignty-boundary pattern, proven) → human gate (first contact / new topic = human act) → signed pouch drop. Inbound → quarantine → strip injection phrasing → wrap as untrusted data → tripwire on rule-rewrite attempts.
- His sidecar envelope (`from/to/thread/ts/sha256/kind/human_approved_by`) is nearly a serialised myelin envelope — bridge later; speak his format now.
- Codify the **three borders + rate gate** (≤3/24h, one thread per topic) in compass as the ecosystem peer-contact standard.
- **This is the correct rung for a *new* peer** — distinct from the high-trust NATS leaf federation we run with Andreas. Trust is a ladder: pouch → … → live bus.

_Acceptance:_ an outbound note is sanitised, human-gated, signed, dropped; an inbound rule-rewrite attempt trips the alarm and halts the channel. **Both proven** — `examples/diplomatic-pouch/` (P_POUCH_OUT/P_POUCH_IN, rate-gate blueprint with deterministic time + fail-closed economy, block-don't-redact border 3, tripwire-before-strip with the evidence in the alarm, channel halt refusing both directions); ecosystem standard `compass/sops/peer-contact.md`. "Signed" per the spec's own §7 (provenance sidecar, who/when/sha256); key-based signatures deferred to the Accord.

### Stage 7 — Compounding lessons loop `[compass · COMP-xx]`
**RavenClaude's `/wrap` + Magnus' skill-corpus telemetry → close miner's open circuit.** End-of-engagement capture: lesson → 9-field scenario YAML (problem/attempts/resolution, scope-tagged, PII-scrubbed via the sanitize pattern, `reviewed: false`) → commit to compass. When ≥2 independent scenarios corroborate → an agent proposes promotion to a best-practice (human approves).

- This is the trace→process path miner promises, formalised with a review gate.
- SOC variant: post-incident scenario → CommunitySOC shared bank, sanitised to cross the member boundary.

_Acceptance:_ a `/wrap` run writes a schema-valid scenario; a corroborating second scenario triggers a promotion proposal.

### Stage 8 — Governance-as-code, ecosystem standard `[compass · C-202]` ✅ STANDARD SHIPPED (compass#76, v0.10.0) · ✉️ REPLY DRAFTED, AWAITING HUMAN SEND
**Promote the converged principles into compass as the standard, with a first reply to Magnus as the proof.**

- An ADR + SOP: fail-closed enforcement, human-on-consequential, adversary-separate-from-fixer, append-only audit, trust-in-rungs — now an ecosystem law, not three private conventions.
- **First diplomatic exchange:** reply to Magnus' proposed note on capability enforcement — we have the material (sovereignty demo + envelope schema + the gate we built in Stage 1). Human-relayed per his protocol; you/Andreas approve content (first contact = human act).
- The reply *is* the proof the standard runs: "you sent a spec; we built it; here's the note, carried by the pouch we built from your Foreign Policy."

_Acceptance:_ the ADR/SOP merged in compass; the note drafted, human-approved, sent via the Stage 6 pouch. **Standard met** — `compass/docs/adr/0001-governance-as-code.md` + `compass/sops/governance-standard.md` (the five principles as one root axiom — *certainty is earned, never assumed* — each tied to its shipped PR+version; #4 audit the keystone). **Reply: drafted + border-clean + staged through P_POUCH_OUT to the named-human gate, then HELD** — sending is a human act per Magnus' own Foreign Policy §0/§3, so the agent stops at the gate; JC/Andreas approve content and relay. The draft cites the seven live adoptions and asks one question back (manifest-declares vs runtime-enforces capability). RedTeam caught one audit-parity overclaim pre-send; fixed.

---

## Dependency graph

```
P-700 enforcement gate (pulse L0) ─┬─► P-702 layered pipeline ─► (SOC containment demo)
C-xxx Honest Oracle ───────────────┴─► P-701 tribunal ─────────┘
                                            │
C-327 signing audit→enforce ─► C-xxx 1b consumer sovereignty gate (bus L0)
                                            │
                                            └─► C-xxx audit/observability tab (Stage 5)
P-703 diplomatic pouch ─► COMP governance standard + reply to Magnus (Stage 8)
COMP wrap/lessons loop (Stage 7, independent)
```

**Critical path to the headline capability** (governed action, fully audited): Stage 1 → 3 → 4 → 5.
**Stage 1b** runs parallel to 1 (same spec, different layer); its hard-deny flip waits on cortex#327 signing-enforce, but the audit-parity version ships immediately.
**Critical path to the relationship** (answer Magnus, prove the standard): Stage 6 → 8 (Stage 1 strengthens the reply).

## Sequencing recommendation

1. **Stage 1 (enforcement gate)** — highest value, lowest risk, unblocks the most, and is the most respectful possible reply to Magnus (we adopted the blueprint). Start here.
1b. **Stage 1b (consumer sovereignty gate)** — same spec, on the bus. Ship audit-parity immediately (the gate, logging not denying), flip to hard-deny when cortex#327 signing lands. Closes the ecosystem's sharpest open gap: the sovereignty cage that doesn't currently lock.
2. **Stage 2 (Honest Oracle)** — afternoon-sized, immediately useful in existing review flows.
3. **Stage 8's reply note** — can go out as soon as Stage 1 lands; don't wait for the whole plan. The relationship compounds in parallel with the build.
4. **Stages 3 → 4 → 5** — the tribunal stack and its dashboard; the demonstrable headline.
5. **Stages 6, 7** — pouch and lessons loop; valuable, not on the critical path.

## What we deliberately do NOT do

- **Don't install Magnus' code** (his gate `.py`, his diplomat zip). Build from the spec — his explicit wish, and his own border #1. Inbound stays inert documents.
- **Don't wire a live connection to Sumarhús.** Rung 1 is the pouch. "The speed a counterpart pushes for tells you who they are" — and we are not the one pushing.
- **Don't collapse the layers.** L0 deterministic, L1 LLM, L2 human are different failure modes with different costs; one "security layer" for all three serves none well (Magnus' point, RavenClaude's tiering, same lesson).
- **Don't auto-promote lessons.** Corroboration proposes; a human disposes (Stage 7).
```
