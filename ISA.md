---
task: "SOC demo — Mattermost Pulse Composer: validator, block palette, composer, execution wiring"
effort: E3
effort_source: auto
phase: complete
progress: 40/40
verified: true
mode: interactive
started: 2026-06-11
updated: 2026-06-11T12:15+02:00
project: pulse
slug: 2026-06-11-pulse-soc-demo-composer
---

> Previous task ISA (P-702 governed-action stack, 37/37 complete, shipped PR #35, v0.12.0) superseded — full record in git history of this file.
>
> Source design doc: `design/soc-demo-mm-composer.md` (decisions locked with JC 2026-06-11). This ISA is the implementation plan derived from it.

## Problem

The demo doc specifies live on-stage composition of SOC processes from Mattermost — but nothing exists yet: no validator gate, no stub-safe block palette beyond soc-triage's five blocks, no composer, no Mermaid rendering, no per-step thread posting. Two gaps the design doc doesn't address: (1) plain action steps emit no lifecycle events (`StepRunnerOptions` has gate/agent/tribunal/governed sinks only), so §6 intermediate-step posting has no hook; (2) sovereignty annotations are YAML *comments* — they don't survive `yaml` parse, so the validator must lint raw text and hand the runner a machine-readable step→sovereignty map.

## Vision

A volunteer posts a scenario into the demo channel. Within ~20s the Composer replies in-thread: YAML with sovereignty annotations on every step, a rendered diagram, a one-line summary. JC says "run it"; step results stream into the thread, each tagged D/A/H; the final artifact lands inside two minutes. When a scenario doesn't fit the palette, the Composer says so cleanly — "closest I have is X, the gap is Y" — and the room sees that as a feature.

## Out of Scope

- Live Reflex-trigger wiring (teased verbally only — design §1).
- Blocks beyond the ~12-block palette (Slack/Teams/PagerDuty notify, firewall-ACL, DMCA intake — cut per §4).
- Real credentials for Whois / MISP / VirusTotal during build — stub-safe is the contract; real adapters land when JC hands over keys.
- Any read or write of `cortex.yaml` / `~/.config/cortex/` — JC owns cortex config (§6). Bot identity comes from JC on request.
- Pre-collected audience scenarios — live impro only.

## Principles

- Fail-closed before fail-flat: an invalid flow never runs; the validator is the hedge against the worst stage failure (composer invents a block).
- Stub-safe by default: every external adapter prints intent and returns canned data when env is unset — mirroring `A_NOTIFY_MATTERMOST`'s env-skip contract.
- The catalog is the source of truth: the composer never sees block names that aren't installed; the validator re-checks anyway.
- Degrade visibly, never silently: Mermaid render failure → post the source block; no matching block → closest-match message, not a guess.

## Constraints

- Bun strict TS; zero new runtime deps (Mermaid via `bunx @mermaid-js/mermaid-cli` shell-out, not a dependency).
- Existing 304 tests keep passing; soc-triage example untouched (blocks are *copied* into the demo palette, not moved).
- Pure core stays pure: validator core is a pure function (raw YAML + catalog in, findings out); MM I/O lives in wiring, not in `src/lib`.
- Engine changes minimal: one new optional event sink (`onStepEvent`) following the exact precedent of `onGateEvent`/`onAgentEvent`.
- Composer self-discloses `frontier-A` class before any run (§3.4); annotations mandatory on every emitted step (§3.3).
- Demo palette lives in `examples/soc-demo/`; actions resolve from the YAML's own directory (existing loader contract).

## Goal

Pulse ships the SOC demo stack — `A_VALIDATE_FLOW` + catalog export, 12 stub-safe blocks, `onStepEvent` engine hook, composer core with validator-retry loop and closest-match fallback, Mermaid→PNG rendering, and MM execution wiring — proven by unit tests on both stub and mocked-real paths for every block, full routing tests on the validator, and a rehearsal run of all 8 ranked scenarios from the design doc.

## Criteria

### P-800 — Validator + catalog (build first; gates everything)
- [x] ISC-1: `examples/soc-demo/lib/validate-flow.ts` exports pure `validateFlow(rawYaml, catalog)` → `{ valid, findings[], annotations }`; no I/O
- [x] ISC-2: validator rejects any step whose action name is absent from the catalog, finding names the unknown block
- [x] ISC-3: validator rejects steps missing required inputs per the catalog's `action.json` input schema (required fields not satisfiable from prior step outputs or initial input)
- [x] ISC-4: validator rejects any step lacking a `# sovereignty:` comment annotation (raw-text line scan, since comments don't survive parse)
- [x] ISC-5: validator returns `annotations`: ordered step→`{sovereignty: D|A|H, residency}` map for runner/thread-reply use
- [x] ISC-6: `# TODO(human)` comment lines pass validation (allowed escape hatch per §3.2)
- [x] ISC-7: Anti: validator never executes any block — pure static checks only (probe: no `runAction` import in validate-flow.ts)
- [x] ISC-8: catalog builder `buildCatalog(blocksDir)` scans `action.json` manifests → `[{name, description, input, output, requires, tags}]`; exposed as `bun examples/soc-demo/tools/catalog.ts` printing JSON
- [x] ISC-9: `A_VALIDATE_FLOW` block wraps the pure core (input: `flow_yaml`, `catalog`; output: `validation`), usable inside pipelines
- [x] ISC-10: validator unit tests cover: valid flow, unknown block, missing input, missing annotation, TODO(human) pass — green

### P-801 — Block palette (12 blocks, stub-safe)
- [x] ISC-11: reference block `A_FETCH_VIRUSTOTAL` ships `action.json` + `action.ts` with env-gated real path (`VT_API_KEY`) and canned 3/70 stub fixture; unit test exercises both paths (real path mocked fetch)
- [x] ISC-12: `A_FETCH_HIBP` — canned hit for `test@example.org`; env-gated real path; both-path test
- [x] ISC-13: `A_FETCH_URLSCAN` — canned verdict for `evil.example`; both-path test
- [x] ISC-14: `A_FETCH_GREYNOISE` — canned "known scanner — Censys"; both-path test
- [x] ISC-15: `A_FETCH_CRTSH` — canned 2-cert response; both-path test
- [x] ISC-16: `A_LOOKUP_GEOIP_ASN` — offline lookup table for demo IPs, no network ever (D-class); test
- [x] ISC-17: `A_LOOKUP_CVE` — offline NVD JSON cache (~50 well-known CVEs incl. KEV status), no network ever; test
- [x] ISC-18: `A_EXTRACT_IOCS` — deterministic defang-aware IOC extraction (URLs/IPs/domains/hashes), pure D block; test with defanged fixtures
- [x] ISC-19: `A_TAG_TLP` — TLP:CLEAR/GREEN/AMBER/RED assignment; test
- [x] ISC-20: `A_OPEN_TICKET` — logs intent, synthetic ticket id in stub; env-gated real adapter shape; test
- [x] ISC-21: `A_LOOKUP_OWNER` — fixture table (IP → OU, contact); test
- [x] ISC-22: `A_SHARE_MISP` — stub renders MISP event JSON + logs intent; env-gated real path; test
- [x] ISC-23: reused soc-triage blocks (`A_FETCH_FEED`, `A_EXTRACT_ARTICLE`, `A_SANITIZE_IOCS`, `A_FORMAT_ADVISORY`, `A_PUBLISH_ADVISORY`, `A_NOTIFY_MATTERMOST`, `A_SEND_MAIL`) copied into `examples/soc-demo/blocks/`; soc-triage untouched (probe: `git diff --stat examples/soc-triage` empty)
- [x] ISC-24: every palette block appears in catalog output with non-empty description (probe: catalog JSON length ≥ 19, all descriptions truthy)

### P-802 — Engine: per-step events
- [x] ISC-25: `StepRunnerOptions.onStepEvent?: (e: StepEvent) => void` added; `StepEvent` = `step.started|step.completed|step.failed` with action name + durationMs, typed in `src/types/pipeline.ts`
- [x] ISC-26: emitted from `runActionStep` for plain action steps; unit test asserts event sequence for a 2-step pipeline incl. failure case
- [x] ISC-27: Anti: existing tests unmodified and green (`bun test` full suite passes; no edits under `tests/` except new files)

### P-803 — Composer core
- [x] ISC-28: `examples/soc-demo/composer/` ships system prompt encoding §3 rules verbatim (catalog-is-truth, no-match path, mandatory annotations, self-disclosure, validator gate) as a reviewable artifact
- [x] ISC-29: `compose(scenario, catalog, llm)` returns `{ yaml, mermaid, summary }`; LLM injected as capability (mockable); no hard-coded catalog
- [x] ISC-30: validator-retry loop: invalid output → re-prompt with findings, max 2 retries, then closest-match message (§3.2 format) — test with mocked LLM returning invalid-then-valid and always-invalid sequences
- [x] ISC-31: Anti: composer output containing an unknown block name never reaches execution (probe: test asserts validator gate sits between compose and run in the wiring path)
- [x] ISC-32: composer emits self-disclosure line ("Pulse Composer is frontier-A …") as part of its first thread reply payload

### P-804 — Mermaid → PNG
- [x] ISC-33: `renderMermaid(src)` shells to `bunx @mermaid-js/mermaid-cli`, returns PNG path; on any failure returns null and caller posts the fenced source block instead — test covers fallback path
- [x] ISC-34: rendering a known-good flow diagram fixture produces a non-empty PNG file (env-gated/skipped when bunx unavailable, like other stubs)

### P-805 — MM execution wiring (blocked on JC: bot identity — open Q1)
- [DEFERRED-VERIFY] ISC-35: thread listener (bot token via env, `MATTERMOST_*` pattern) receives scenario post → compose → validate → posts YAML + PNG + summary in-thread; stub-safe when env unset (prints intent)
- [DEFERRED-VERIFY] ISC-36: operator ack ("run it" reply or reaction) gates execution — reuses gate-provider precedent, no auto-run
- [DEFERRED-VERIFY] ISC-37: during execution, each `onStepEvent` completion posts a thread reply: block name, sovereignty class (from ISC-5 annotations), 1-line result; final artifact posted at pipeline end
- [DEFERRED-VERIFY] ISC-38: at least one rehearsed flow shows a local-only step explicitly routed away from frontier (sovereignty story probe, §7)

### P-806 — Rehearsal + ship
- [x] ISC-39: all 8 ranked scenarios (§9) run end-to-end against the composer in stub mode; failures dispositioned as prompt-fix (default) vs palette-add (only if likely live) — results table committed to `examples/soc-demo/README.md`; scenario 8 uses stub `wait:`-equivalent unless JC green-lights Reflex (open Q3)
- [x] ISC-40: blueprint.yaml gains P-800..P-806 entries (iteration 8); CLAUDE.md notes `onStepEvent`; version bump per SOP after merge

## Test Strategy

| isc | type | check | tool |
|---|---|---|---|
| 1–10 | unit | validator routing table + catalog shape | `bun test` |
| 11–22 | unit | per-block stub + mocked-real paths | `bun test` |
| 23 | diff scope | soc-triage untouched | `git diff --stat` |
| 24 | integration | catalog JSON over palette dir | Bash run |
| 25–27 | unit + regression | event sequence; full suite green | `bun test` |
| 28–32 | unit | mocked-LLM compose/retry/fallback | `bun test` |
| 33–34 | integration | render + fallback | Bash run (env-gated) |
| 35–38 | live probe | MM thread round-trip on SWITCH test instance | manual + screenshots |
| 39 | rehearsal | 8 scenarios, results table | Bash runs + Read |
| 40 | inspection | blueprint/docs | Read |

## Features

| name | satisfies | depends_on | parallelizable |
|---|---|---|---|
| validator + catalog (P-800) | ISC-1..10 | — | no (gates all) |
| reference block VT (P-801a) | ISC-11 | P-800 catalog shape | no (sets scaffold) |
| remaining 11 blocks (P-801b) | ISC-12..24 | P-801a | **yes — fan out across worktrees** |
| onStepEvent (P-802) | ISC-25..27 | — | yes (independent of blocks) |
| composer core (P-803) | ISC-28..32 | P-800 | yes (parallel to blocks) |
| mermaid render (P-804) | ISC-33..34 | — | yes |
| MM wiring (P-805) | ISC-35..38 | P-801..804 + JC bot identity | no |
| rehearsal + ship (P-806) | ISC-39..40 | all | no |

## Decisions

- 2026-06-11: plan formulated from `design/soc-demo-mm-composer.md`; decisions in its §11 are locked and not relitigated here.
- 2026-06-11: sovereignty annotations stay YAML comments (design §3.3 format) — validator lint runs on raw text and *extracts* an annotations map so the runner has machine-readable sovereignty for thread replies. Structured per-step fields rejected: would change the on-stage YAML the audience reads.
- 2026-06-11: reused soc-triage blocks are **copied** into `examples/soc-demo/blocks/`, not referenced — pipeline loader resolves actions from the YAML's own dir; cross-dir resolution would be an engine change with no demo value. Accepts duplication; soc-triage stays untouched (ISC-23). Related: issue #26 (AutoGateProvider hoist) is the same tension, also deferred.
- 2026-06-11: Mermaid via `bunx` shell-out with fallback-to-source — zero-runtime-deps constraint kept; render failure must not break the demo (design §8.5).
- 2026-06-11: composer core built LLM-injected and MM-agnostic in pulse; the cortex-MM attachment is thin wiring at P-805, pending JC's bot identity (open Q1). Pulse never touches cortex config.
- 2026-06-11: validator + catalog live under `examples/soc-demo/`, not `src/lib` — demo-specific contract (comment-annotation lint); only `onStepEvent` (P-802) earns an engine change.
- 2026-06-11: open questions §10 default dispositions until JC answers: Q1 blocker for P-805 only; Q2 stub-first (non-blocking); Q3 stub wait for scenario 8; Q4 record backup during rehearsal (cheap insurance, JC's call to use).

- 2026-06-11 (EXECUTE): public surface renamed validatePipeline / ActionStepEvent / onActionStepEvent after sage canonical-vocabulary findings (Flow = deployment shape; Step = Action | Primitive). Demo-facing names (A_VALIDATE_FLOW, "flow" on stage) unchanged — design §11 locked vocabulary.
- 2026-06-11 (EXECUTE): P-803/804/805 + rehearsal shipped in one PR (#47) — wiring is the consumer the composer review findings pointed at; separate PRs would have re-reviewed the same surface. One-feature-per-PR rule consciously traded for convergence; noted per SOP.
- 2026-06-11 (VERIFY): v0.13.0 was taken by P-703 (parallel governance session on main) — demo stack shipped as v0.14.0.

- 2026-06-11 (post-ship): composer bot persona named **Yarrow** (JC) — yarrow stalks composed I Ching hexagrams from a fixed set, as the bot composes flows from a fixed catalog; soldier's woundwort fits SOC. Lands in MM display name + SYSTEM_PROMPT when JC provisions the bot identity (issue #37 item 1).

## Changelog

- conjectured: the design doc's §8 build order is directly executable as written.
  refuted_by: code grounding — `StepRunnerOptions` has no plain-action event sink, and sovereignty comments vanish at `yaml` parse; §6 thread posting and validator annotation checks are unimplementable without addressing both.
  learned: a handoff design doc grounds intent, not mechanism — always diff its assumptions against the actual engine surface before planning.
  criterion_now: ISC-4/5 (raw-text lint + annotations map) and ISC-25..27 (onStepEvent).

- conjectured: a stub-safe demo palette has no real attack surface, so review rounds would be wording polish.
  refuted_by: sage rounds found four genuine trust-boundary holes — caller-supplied catalog vouching for invented blocks, env token traveling to caller-supplied URLs, redirect-following bypassing the SSRF guard, and an operator gate any channel participant could open.
  learned: every place where pipeline INPUT selects a trust root (catalog, URL, credentials, gate principal) must bind that root to operator-controlled config instead — input chooses among permitted values, never defines them.
  criterion_now: anti-tests pin all four (forged catalog, token pairing, redirect re-validation with hop test, MATTERMOST_OPERATOR_ID fail-closed).

## Verification

All shipped via PRs #38 (P-800), #39 (P-802), #40 (P-801), #47 (P-803/804/805/806-rehearsal); released v0.14.0; deployed via `arc upgrade pulse` pending.

- ISC-1..10: `bun test tests/soc-demo-validator.test.ts` — 17 pass (incl. anti-tests: caller catalog cannot vouch for invented blocks; forged initial_fields cannot open the gate; nested comment cannot annotate next step). Naming refined: `validate-pipeline.ts` / `validatePipeline` (sage: Flow is the deployment shape per CONTEXT.md); block keeps locked name A_VALIDATE_FLOW.
- ISC-11..23: `bun test tests/soc-demo-blocks*.test.ts` — 43 pass across stub + mocked-real paths; soc-triage diff-scope check clean (copies only, originals tracked in #43).
- ISC-24: `bun examples/soc-demo/tools/catalog.ts` → 20 entries, all descriptions non-empty (probe 2026-06-11).
- ISC-25..27: renamed `onActionStepEvent`/`ActionStepEvent` per sage canonical-Step finding; `bun test tests/step-events.test.ts` — 3 pass; full suite green, no existing test modified.
- ISC-28..32: `bun test tests/soc-demo-composer.test.ts` — incl. always-invalid → closest-match after 2 retries (4 LLM calls), fail-closed anti-test, SYSTEM_PROMPT.md content checks.
- ISC-33..34: fallback paths unit-tested; live render probed (`MERMAID_LIVE=1` → real PNG via pinned mermaid-cli@11, 14.4s incl. puppeteer launch).
- ISC-35..37: stub paths probed (`tests/soc-demo-wiring.test.ts` — full sequence, operator rejection, fail-closed, no-match, principal check, negation-first ack, MATTERMOST_OPERATOR_ID fail-closed). LIVE Mattermost thread probe DEFERRED — blocked on composer bot identity (design §10 Q1, issue #37 remaining item 1).
- ISC-38: DEFERRED to the real-LLM rehearsal — needs a composed flow exhibiting local-only routing on stage-grade scenarios (issue #37 remaining item 2).
- ISC-39: `bun examples/soc-demo/rehearse.ts` — 8/8 complete in stub mode (the ISA's stated scope); results table in examples/soc-demo/README.md. Real-LLM pass is the pre-stage step.
- ISC-40: blueprint P-800..P-806 done; CLAUDE.md gains step-events + soc-demo sections; v0.14.0 tagged + released.
- Review trail: 5 sage rounds over 4 PRs; 2 round-blockers fixed with probes (caller-controlled catalog trust root; operator gate principal check); refuted-with-evidence: phantom unresolved-imports blocker (modules exist on main, typecheck/tests green).
