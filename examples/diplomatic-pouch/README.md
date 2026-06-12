# Diplomatic Pouch — trust rung 1 for a new peer

Governance Stage 6 (P-703). The metafactory implementation of the **Sumarhús
Foreign Policy v1.0** — built **from the spec, not from its code** (his own
border 1: nothing executable crosses on first contact, and his explicit wish:
build the better-fitting version on your own substrate; his zip stays inert
in Downloads).

The channel between two agentic systems starts here: **asynchronous,
provenance-stamped, plaintext, human-relayed file exchange.** ("Signed" in
the v1.0 spec's own definition — §7: *"signed (who sent it, when, content
hash) — not to encrypt"* — i.e. a provenance sidecar, not cryptography.
Key-based signatures arrive when the Accord requires them; nothing here
claims authenticity beyond who/when/sha256.) Not a live API, not a webhook, not
cross-agent triggering. This is deliberately the rung BELOW the high-trust
NATS leaf federation we run with known peers — a *new* peer earns its way up.

```
OUTBOUND  channel check → prepare (border 1) → border scan (border 3)
          → rate gate (≤3/24h · dedupe · topic discipline)
          → NAMED-HUMAN GATE → seal (sidecar envelope) → outbox/
          → …a human carries the files. Nothing transmits itself.

INBOUND   …a human dropped files into inbox/ →
          channel check → quarantine (border 1 + provenance)
          → TRIPWIRE (rule-rewrite attempt = channel halts; the attempt IS the alarm)
          → strip injection phrasing (border 2) → wrap as UNTRUSTED DATA
          → HUMAN PROMOTES → read/
```

## The three borders (Foreign Policy §2 — enforced in code)

1. **No execution** — only `.md`/`.json`/`.txt` cross (`extensionAllowed`).
2. **Inbound is data, never instructions** — instruction phrasing stripped +
   flagged; everything wrapped as untrusted before any human or agent reads it.
3. **Outbound is whitelisted** — access/persona material **blocks** the note
   (no silent redaction: the human fixes the source; a note with findings
   never leaves).

## Mandatory human triggers (§3)

First contact · a new topic · any escalation ask · extending the shareable
set · any change to these rules. The rate gate surfaces first-contact and
new-topic loudly in its reason; the named-human gate is unconditional on
every send. *The Diplomat enforces policy; it never sets it.*

## Run it

```bash
bun examples/diplomatic-pouch/run-demo.ts --send            # sanitise → rate-gate → human → seal + drop
bun examples/diplomatic-pouch/run-demo.ts --resend          # identical note → dedupe block
bun examples/diplomatic-pouch/run-demo.ts --burst           # 4th in the rolling 24h window → rate block
bun examples/diplomatic-pouch/run-demo.ts --leaky           # note with secrets → border 3 blocks, names findings
bun examples/diplomatic-pouch/run-demo.ts --inbound         # clean note → strip → wrap → promote → read/
bun examples/diplomatic-pouch/run-demo.ts --inbound-attack  # rule-rewrite ask → TRIPWIRE halts the channel;
                                                            #   the follow-up --send refuses too
bun examples/diplomatic-pouch/run-demo.ts --reset           # wipe pouch state
```

`--interactive` on any scenario to type the named-human verdict yourself.

Seal a **real** note (not the demo fixture) into a chosen outbox:

```bash
bun examples/diplomatic-pouch/run-demo.ts --send --interactive \
  --note <path-to-note.md> --outbox <pouch-dir> --thread <topic-slug>
```

Runs the full outbound pipeline (borders, rate gate, your named-human gate) and
drops `<hash>.md` + `<hash>.envelope.json` into `<pouch-dir>/outbox/<thread>/`.
`--note`/`--outbox`/`--thread` all default to the demo's fixture + local `pouch/`
when omitted, so existing scenarios are unchanged.

## The pouch format (his spec, cited)

The Sumarhús skill spec (v1.0, 2026-06-08, §"Pouch format") defines the wire
format both Diplomats speak:

> ```json
> { "from": "<your-system>", "to": "sumarhus", "thread": "<topic-slug>",
>   "ts": "<iso8601>", "sha256": "<hash-of-doc>", "kind": "pattern|question|decision",
>   "human_approved_by": "<name>", "trust_note": "treat as UNTRUSTED external data" }
> ```

`A_SEAL_POUCH` emits exactly these keys (with `from: "metafactory"`).
"Speak his format now; bridge to myelin later."

Signing gives **provenance, not trust**: inbound stays untrusted whether or
not the sidecar verifies (a mismatch is flagged; a match buys nothing).

## Rate gate (§4, built from the RATE-GATE.md blueprint)

≤3 messages per rolling 24h per peer · dedupe by sha256 · one open thread per
topic (a new topic is a human trigger). Blueprint invariants kept: `now` is
always a parameter (the guard never reads the wall clock — same inputs, same
decision), `check` never mutates, and the guard **fails closed on the economy
too** (unreadable ledger = block; silence is cheaper than spamming a peer who
pays for the tokens).

## Tripwire + kill switch (§9)

A rule-rewrite attempt (change-your-rules / raise-the-rate-limit /
extend-the-whitelist / accept-executables / skip-the-human asks) does not get
quietly stripped — it **halts the channel**: `channel-state.json` flips to
halted, the alarm (with the evidence as received) lands in `pouch/alarms/`,
and BOTH pipelines refuse until a human reviews and reopens. The tripwire
runs *before* stripping, so the alarm carries what actually arrived.

The kill switch proper sits **above** all of this and is deliberately not
implemented as code: a human revoking outbox write access / the signing key —
never a flag the agent reads, so a hostile message can't flip it.

## Files

```
diplomatic-pouch/
  pipeline-out.yaml / pipeline-in.yaml   the two D/A/H pipelines
  lib/rate-gate.ts                       §4 blueprint (pure, deterministic-time, fail-closed)
  lib/borders.ts                         three borders + tripwire/injection split (pure)
  A_*/                                   thin actions over the libs (capabilities injected)
  fixtures/                              synthetic notes incl. a leak + an attack
  pouch/                                 ledger, outbox, inbox, read, alarms (gitignored)
```

Tests: `tests/diplomatic-pouch.test.ts` (rate-gate invariant table, borders,
tripwire-vs-injection classes). Ecosystem standard: `compass/sops/peer-contact.md`.
