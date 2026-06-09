# 1. Pulse retains its own transport; myelin convergence deferred

Date: 2026-05-30

## Status

Accepted

## Context

Pulse needs a transport abstraction for NATS-based messaging — consuming `cue.fired` events and emitting process events. On 2026-04-04 the team decided to build this as a shared `packages/transport/` package from day one, reasoning that Stage 2 (Grove) would need the same abstraction and building it shared avoids a later extraction.

Myelin came into existence after that decision. It now defines a seven-layer protocol stack for the agentic ecosystem and claims **L2 Transport** as one of its own layers, alongside **L3 Envelope** (the universal message wrapper, where sovereignty metadata travels with the message) and **L4 Identity**. Myelin owns the NATS subject namespace spec and the envelope schema.

This produces two candidate owners for the word — and the responsibility — "Transport": pulse's `packages/transport/` package, and myelin's L2 layer. Left unaddressed, a future reader encounters two transport layers in the ecosystem with no record of why they coexist or which one is authoritative. The pulse blueprint already anticipates convergence at the envelope level (actions producing and consuming Myelin envelopes, process events carrying sovereignty), gated on myelin features (`myelin:MY-101`, `myelin:MY-102`).

A decision is needed now to prevent premature coupling to a still-evolving myelin protocol while keeping the convergence path open.

## Decision

We will keep pulse's own transport abstraction (`packages/transport/`) as the authoritative transport for pulse for now. We will **not** converge on myelin's L2 Transport layer at this time.

Myelin integration proceeds **envelope-first and incrementally**: pulse actions and process events adopt the Myelin **Envelope** (L3) and **sovereignty** metadata as a future step (per blueprint, gated on the relevant myelin features) before any consideration of replacing pulse's transport with myelin's L2. Transport convergence is explicitly deferred and revisited only once pulse actions are actually exchanging Myelin envelopes in practice.

The rationale: myelin postdates pulse and its lower layers are still evolving; coupling pulse's transport to myelin's L2 today would import that churn for no present benefit. The envelope is the smaller, higher-value, lower-risk integration surface and the natural first contact point.

## Consequences

- **Positive:** Pulse stays decoupled from myelin's still-evolving lower layers; the 2026-04-04 shared-package investment remains valid; Grove can still share `packages/transport/`; the convergence path stays open without forcing it.
- **Positive:** A clear, recorded boundary — myelin owns the Envelope/sovereignty schema (foreign terms in `CONTEXT.md`); pulse owns its transport package.
- **Negative / watch out for:** Two transport layers coexist in the ecosystem until convergence; this must not drift into two competing abstractions. When pulse actions begin exchanging Myelin envelopes, revisit this ADR — convergence on myelin L2 may then be warranted, which would supersede this decision.
- **Constraint:** Until superseded, pulse code and docs treat **Transport** as pulse-owned and **Envelope** / **Sovereignty** as myelin-owned (foreign). New transport work lands in `packages/transport/`, not against myelin L2.
