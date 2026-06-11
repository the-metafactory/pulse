# SOC Demo — Mattermost Composer

**Date:** 2026-06-11
**Status:** Draft for implementation — decisions locked with JC in Discord 2026-06-11
**Audience for the demo:** NREN / CERT / CISO / sec-eng (SWITCH-CERT-shaped room)
**Author:** Ivy (JC's coordinator agent), capturing decisions made with JC
**Implementation handoff:** an agent picking this up should be able to execute without further alignment from JC

---

## 1. The demo we are building

The headline moment is **live composition of a SOC process on stage**, driven from Mattermost:

1. JC invites an audience member to describe a security scenario in plain language.
2. The volunteer posts that scenario into a Mattermost thread.
3. A **Pulse Composer** bot replies in the same thread with:
   - a YAML pulse flow,
   - a Mermaid diagram (rendered to PNG and attached),
   - **per-step sovereignty annotations** (`D` deterministic local / `A` agentic local / `H` agentic frontier, plus `data_residency`).
4. JC acknowledges ("run it").
5. The flow executes; intermediate step outputs post into the thread; the final artifact (advisory, ticket, notification) appears.
6. Total wall-clock target: **~2 minutes** from ack to final artifact.

The story the audience must walk out with: **`D / A / H` composition + sovereignty routing in plain YAML, assembled live**. Not "a big library of blocks."

### Out of scope for the demo

- **Live Reflex-trigger wiring.** Reflex is one day old in the tree. A trigger that fires *after* the demo ends is invisible to the audience. Reflex is **teased only**: "in production this fires on the incoming abuse-mail, not on a button." No on-stage cron/bus/webhook setup.
- A large block library. We ship ~10 curated blocks, not 40.
- Real credentials for Whois / MISP / VirusTotal during dev. Stub-safe defaults are the contract; JC will hand over real credentials later.

### Audience input model

**Live, from the room.** JC plays impro theatre — no pre-collected warm-ups, no hybrid. The composer must handle whatever comes; the "no matching block" fallback (§5) is the safety net.

---

## 2. Roles on stage

| Bot | Identity | Role on stage | Sovereignty class |
|---|---|---|---|
| **Ivy** | JC's coordinator (existing) | Operator-side companion, may narrate | frontier-A |
| **Pulse Composer** | **Fresh persona, new MM bot identity** | Reads scenario → emits YAML + diagram + sovereignty annotations | **frontier-A** (text → YAML is reasoning) |
| Pulse runtime | Existing cortex stack on SWITCH test MM | Executes the flow, posts intermediate steps | Per-step (mixed) |

**Why fresh, not Luna:** clean story, no cross-team baggage to explain on stage. The audience hears "a different instance of the agent" without JC having to play two roles.

**Two-bot surface (Ivy + Composer):** the audience must see the boundary. Different display name, different avatar, ideally different accent colour. The implementing agent should pick a visually distinct identity for Pulse Composer.

---

## 3. The composer prompt — non-negotiable rules

These rules go into Pulse Composer's system prompt and are tested before stage.

1. **Block catalog is the source of truth.** The composer is given the *actual* installed block catalog (name, description, input/output schema) at call time. It must not invent block names.
2. **No-match path.** If no block fits a requested step, the composer must reply with:
   > "Closest I have is `A_X`; the gap is *…*. Pivot to *…*?"
   It must **never** emit an unknown block name. A `# TODO(human)` comment line is acceptable in the YAML when a step is genuinely unrepresentable.
3. **Sovereignty annotations are mandatory.** Every step in the emitted YAML carries `# sovereignty: D|A|H, residency: CH|EU|frontier`. This is the demo's headline; missing annotations make the demo land flat.
4. **Self-disclosure.** The composer's *own* sovereignty class is `frontier-A` and a slide / thread message must say so before the run. Otherwise "sovereignty matters" gets muddy when the audience realises a frontier model picked the local-only step.
5. **Validator gate.** Composer output is piped through `A_VALIDATE_FLOW` (§4) before execution. Validator failure → composer is re-prompted with the validator's findings; not human-corrected on stage.

---

## 4. Block palette — what to build

All new blocks ship with a **stub-safe / `--demo`** path that prints intent and returns canned data when keys/secrets are unset. This mirrors the existing contract in `examples/soc-triage/A_NOTIFY_MATTERMOST` (skipped when env unset). Same pattern: env-checked at execute time, deterministic fixture response when missing.

### Ingress / enrichment

| Block | Purpose | Stub fixture |
|---|---|---|
| `A_FETCH_HIBP` | email/domain breach check | canned hit for `test@example.org` |
| `A_FETCH_URLSCAN` | submit URL → verdict + screenshot ref | canned verdict for `evil.example` |
| `A_FETCH_VIRUSTOTAL` | URL/file-hash reputation | canned 3/70 vendors flagged |
| `A_FETCH_GREYNOISE` | IP background-noise / scanner reputation | canned "known scanner — Censys" |
| `A_FETCH_CRTSH` | cert-transparency search (typosquat / shadow-IT) | canned 2-cert response |
| `A_LOOKUP_GEOIP_ASN` | IP → country + ASN | offline MaxMind-lite table for demo IPs |
| `A_LOOKUP_CVE` | CVE → CVSS + KEV status | offline NVD JSON cache for ~50 well-known CVEs |

### Parse / shape

| Block | Purpose |
|---|---|
| `A_EXTRACT_IOCS` | deterministic IOC pull (URLs/IPs/domains/hashes), defang-aware. **D-only** counterpart to the agentic triage path — lets a flow stay D-only if the operator wants. |
| `A_TAG_TLP` | assign TLP marking (TLP:CLEAR / GREEN / AMBER / RED). FIRST/TI-aware audiences love this. |

### Decide / act

| Block | Purpose | Stub fixture |
|---|---|---|
| `A_OPEN_TICKET` | RT / Jira ServiceDesk. Audience asks "how do I plug OTRS in?" — stub-safe answer. | logs intent, returns synthetic ticket id |
| `A_LOOKUP_OWNER` | IP/MAC → responsible OU/contact. **The NREN-specific block.** CMDB / NetDB adapter, fixture-backed for the demo. | small fixture table of (IP → OU, contact) |

### Govern (high-value optional)

| Block | Purpose |
|---|---|
| `A_SHARE_MISP` | render + push a MISP event. Even in stub mode this is a strong story — most of the audience already runs MISP. JC will provide real MISP credentials later. |

### Existing blocks to reuse (no work)

From `examples/soc-triage/`:
- `A_FETCH_FEED`, `A_EXTRACT_ARTICLE`, `A_SANITIZE_IOCS` (ingress / parse)
- `A_FORMAT_ADVISORY`, `A_PUBLISH_ADVISORY` (govern)
- `A_NOTIFY_MATTERMOST`, `A_SEND_MAIL` (output)
- `agent:` primitive with `sovereignty:{ model_class, frontier_ok, data_residency }`
- `gate:` primitive for human verdict

### Internal adapters (JC supplies later)

- **Whois** — SWITCH internal tooling. Will land as `A_WHOIS_LOOKUP`. Stub-first now.
- **MISP** — SWITCH internal instance. `A_SHARE_MISP` above. Stub-first now.

### Cut (not before the talk)

Slack / Teams / PagerDuty notify, firewall-ACL push, DMCA-mail intake. Each is a ~30-minute variant of an existing block; no demo value in pre-building them.

### Guardrail block (deterministic, mandatory)

| Block | Purpose |
|---|---|
| **`A_VALIDATE_FLOW`** | Sits between compose and execute. Deterministic. Checks: (a) every block name exists in the installed catalog, (b) required inputs are present, (c) sovereignty annotations exist on every step. Fail-closed: invalid flow does not run. This is the single biggest hedge against the worst stage failure (composer invents a block). |

---

## 5. Composer behaviour — sequence

```
audience volunteer ──posts scenario──▶ MM thread
                                        │
                          Pulse Composer reads thread
                                        │
                       (1) drafts YAML + sovereignty annotations
                       (2) renders Mermaid → PNG
                       (3) posts: YAML block + PNG + 1-line summary
                                        │
                              A_VALIDATE_FLOW gate
                          ┌─────────────┴─────────────┐
                          ▼                           ▼
                     ✓ valid                     ✗ invalid
                          │                           │
                  JC acks "run it"           composer re-prompted
                          │                  with validator findings
                          ▼                           │
                   pulse runtime                      └──▶ retry (max 2)
                  executes flow                              │
                          │                                  ▼
            intermediate step outputs            stop, narrate gap to audience
            posted as thread replies             ("closest is X; pivot?")
                          │
                  final artifact in thread
```

### "No matching block" path (live failure mode)

If after 2 validator retries no valid flow emerges, the composer must post the *closest-match* message (§3.2) and JC pivots the scenario verbally. This is the impro safety net — it is not a failure of the demo, it's a feature ("the system tells me when it can't").

---

## 6. Mattermost integration

- **Stack:** the existing cortex-on-MM stack on the SWITCH test instance. **The implementing agent must not read or modify `cortex.yaml` or `~/.config/cortex/`** — JC handles config changes directly. Ask JC for any needed bot identity / channel configuration.
- **Bot identity for Pulse Composer:** new identity, separate from any existing Ivy / Cortex bot on the stack. JC will paste the relevant manifest snippet (no secrets) on request.
- **Channel:** single dedicated demo channel; threads per scenario.
- **Intermediate-step posting:** each executed step writes a short summary (block name, sovereignty class, 1-line result) as a thread reply, so the audience can follow execution without watching a terminal.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Composer invents a block name on stage | `A_VALIDATE_FLOW` gate + prompt rule §3.2 + closest-match fallback |
| Sovereignty story gets muddy ("but the composer is frontier!") | Composer self-discloses its own class up front (§3.4); at least one flow must show a local-only step explicitly routed away from frontier |
| Live MM auth flake mid-demo | Pre-warm the stack 30 min before; have a recorded backup of one canonical run (CERT-advisory → impact note) to play if MM is down — JC's call whether to use it |
| Audience scenario lands outside palette | Closest-match pivot; JC's impro carries it |
| Composer too slow (>20s for YAML + diagram) | Use `smart`-tier LLM for compose, `fast`-tier for diagram caption; pre-load catalog into prompt (don't fetch per call) |
| Two bots confuse the audience | Distinct avatar/colour/name for Ivy vs Pulse Composer; brief slide showing the boundary |

---

## 8. Implementation order (for the picking-up agent)

Build in this order; each step gates the next.

1. **`A_VALIDATE_FLOW`** — deterministic, no external deps. This is the safety net for everything else; ship it first.
2. **Stub-safe block scaffold** — one block (`A_FETCH_VIRUSTOTAL`) end-to-end as the reference: `action.json`, `action.ts`, stub fixture, real-adapter behind env-check. Mirror `A_NOTIFY_MATTERMOST`'s env-skip pattern.
3. **Remaining 11 blocks** — same scaffold, in the order listed in §4 (ingress → parse → act → govern). Each ships with a fixture and a unit test that exercises both stub and (mocked) real paths.
4. **Pulse Composer bot** — MM-attached agent with the system prompt rules from §3. Receives scenario, emits `{ yaml, mermaid, summary }`. Catalog is loaded from the installed pulse registry at call time, not hard-coded.
5. **Mermaid → PNG pipeline** — render server-side, attach to MM post. (Mermaid CLI or `@mermaid-js/mermaid-cli` in the runtime; fall back to posting the source block if rendering fails — don't let rendering break the demo.)
6. **Execution wiring** — composer output → `A_VALIDATE_FLOW` → operator-ack gate → pulse runtime → per-step thread replies.
7. **End-to-end rehearsal** — run all 8 ranked scenarios (§9) against the composer. Any failure is either a missing block (add to palette only if the scenario will likely come up live) or a composer-prompt bug (fix the prompt, not the palette).

---

## 9. Scenarios the composer must handle

Ranked by likelihood in a SWITCH-CERT-type room. The first six fall out of the ingress/enrich/notify spine; rehearse all eight.

1. **CERT advisory → "does it touch us?"** — incoming CVE/NCSC/CERT-EU advisory → match against asset inventory → impact note to admins. *Needs `A_LOOKUP_CVE` + `A_LOOKUP_OWNER`.*
2. **Credential-leak handling** — paste/HIBP hit → identify owner → force reset + notify. *Needs `A_FETCH_HIBP` + `A_LOOKUP_OWNER`.*
3. **Suspicious-login triage** — Shibboleth/SAML login from anomalous geo/ASN → enrich → analyst gate → block or accept. *Needs `A_LOOKUP_GEOIP_ASN` + `gate:`.*
4. **DMCA / abuse-mail intake** — incoming notice → IP/log lookup → owner → notification + compliance log. *Needs `A_LOOKUP_OWNER`.*
5. **Open-port / shadow-IT discovery** — new exposed service → owner lookup → notify. *Very NREN. Needs `A_FETCH_CRTSH` + `A_LOOKUP_OWNER`.*
6. **Brand abuse / typosquat** — new lookalike domain → screenshot/urlscan → registrar abuse report. *Needs `A_FETCH_CRTSH` + `A_FETCH_URLSCAN`.*
7. **DDoS / scanner traffic** — burst seen → enrich (GreyNoise/ASN) → blocklist or peer notify. *Needs `A_FETCH_GREYNOISE` + `A_LOOKUP_GEOIP_ASN`.*
8. **GDPR/FADP breach-notice draft** — incident → 72h-timer draft → DPO gate → regulator queue. *Glue: needs a timer primitive — confirm with JC whether to lean on Reflex for this one or stub a `wait:` step. If Reflex, this scenario doubles as the Reflex tease.*

---

## 10. Open questions for JC (before implementation finalises)

The picking-up agent should resolve these before stage:

1. **Pulse Composer MM bot identity** — does the existing cortex-MM stack already have a spare bot identity to reuse, or do we provision a fresh one? (JC owns this; do not edit `cortex.yaml`.)
2. **Whois / MISP credentials** — what's the handover plan and timing? Stub-first is fine for build; real adapters land when credentials arrive.
3. **Scenario 8 (FADP timer)** — Reflex-backed timer or stub `wait:`? Default to stub for the talk unless Reflex is demo-ready.
4. **Backup recording** — does JC want a canned recording of one canonical scenario for use if live MM fails, or trust the impro?

---

## 11. Decisions locked (do not relitigate)

- Live compose + diagram + run on stage. **Yes.**
- Reflex teased only, not on stage. **Yes.**
- Audience input live, no pre-collection. **Yes.**
- Fresh "Pulse Composer" persona, not Luna. **Yes.**
- Palette size ~12 blocks (10 from original list + VirusTotal + Validator). **Yes.**
- Stub-safe defaults for every external adapter. **Yes.**
- Mattermost as the only input/output surface for the demo. **Yes.**
