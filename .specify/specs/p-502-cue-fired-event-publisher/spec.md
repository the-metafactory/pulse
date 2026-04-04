# Specification: P-502 Cue.fired Event Publisher

## Overview

When Pulse evaluates cues and determines one should fire, it must publish a `cue.fired` event to the NATS message bus. This closes the activation loop defined in DD-62: cues trigger processes, and the firing itself is observable infrastructure that Miner captures for provenance tracking and other components can subscribe to for orchestration.

P-502 builds on P-501 (cue consumer) and uses P-500's transport abstraction. Where P-501 subscribes to incoming cue events, P-502 publishes outbound cue.fired events when cue evaluation results in activation.

## User Scenarios

### Scenario 1: Cue Fires Successfully

- **Given** Pulse has evaluated a cue and determined it should fire
- **When** the cue evaluation completes with a positive result
- **Then** Pulse publishes a `cue.fired` event to `mf.{network_id}.cue.fired`
- **And** the event uses CloudEvents v1.0 envelope with metafactory extensions (DD-68)
- **And** Miner and other subscribers receive the event for provenance tracking

### Scenario 2: Multiple Cues Fire from Same Trigger

- **Given** a single event triggers multiple cue evaluations
- **When** two or more cues evaluate to "fire"
- **Then** Pulse publishes separate `cue.fired` events for each cue
- **And** events share the same `mfcorrelationid` linking them to the trigger
- **And** each event has a unique `id` (ULID)

### Scenario 3: Cue Fire with Full Provenance

- **Given** an agent session triggers a cue via a programmatic cue fire
- **When** the cue fires
- **Then** the `cue.fired` event includes `mfsessionid` for Miner provenance
- **And** `mfactor` identifies the agent/operator that initiated the trigger
- **And** `mfcausationid` links to the event that caused this cue to fire

### Scenario 4: Transport Failure Handling

- **Given** Pulse attempts to publish a `cue.fired` event
- **When** the NATS connection is unavailable
- **Then** Pulse uses the transport abstraction's error handling (P-500)
- **And** DualWriteTransport writes to fallback if configured
- **And** the cue fire is logged locally as fallback (JSONL)

### Scenario 5: Unit Testing Without NATS

- **Given** a test exercises cue firing logic
- **When** the test runs under `bun test`
- **Then** `InMemoryTransport` captures the `cue.fired` event
- **And** tests can assert on event contents without a live NATS server

## Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Publish `cue.fired` events to subject `mf.{network_id}.cue.fired` using TransportPublisher interface from P-500 | High |
| FR-2 | Events use CloudEvents v1.0 envelope with required fields: `specversion`, `id` (ULID), `source` (URI: `metafactory://{network_id}/pulse`), `type` (`cue.fired`), `time` | High |
| FR-3 | Include required metafactory extension `mfnetworkid` in all events | High |
| FR-4 | Support optional extensions: `mfcorrelationid`, `mfcausationid`, `mfsequence`, `mfactor`, `mfsessionid` | Medium |
| FR-5 | Event payload includes cue metadata: cue ID, cue type, trigger source, and binding target (process ID) if known | High |
| FR-6 | Generate ULID for event `id` field ensuring uniqueness and time-ordering | High |
| FR-7 | Include `network_id` in both NATS subject and event body (binary content mode pattern per DD-68) | High |
| FR-8 | Provide `CueFiredPublisher` class/function that integrates with Pulse's cue evaluation subsystem | High |
| FR-9 | Support graceful degradation when transport is unavailable (log warning, continue execution) | Medium |
| FR-10 | Work with all TransportPublisher implementations: NATSTransport, InMemoryTransport, DualWriteTransport | High |

## Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-1 | Publishing must not block cue evaluation — async fire-and-forget with error logging | High |
| NFR-2 | Event serialization uses JSON (CloudEvents structured content mode for NATS) | High |
| NFR-3 | Unit tests use InMemoryTransport exclusively — no NATS dependency in test suite | High |
| NFR-4 | Code lives alongside P-501 consumer in same module area (e.g., `src/lib/nats/` or `packages/transport/pulse/`) | Medium |
| NFR-5 | ULID generation uses standard library (e.g., `ulid` package) for consistency with ecosystem | Low |

## Event Schema

CloudEvents envelope per DD-68:

```typescript
interface CueFiredEvent {
  // CloudEvents required fields
  specversion: "1.0";
  id: string;                    // ULID
  source: string;                // "metafactory://{network_id}/pulse"
  type: "cue.fired";
  time: string;                  // ISO 8601 timestamp

  // CloudEvents optional fields
  datacontenttype?: "application/json";
  subject?: string;              // Cue ID for filtering

  // metafactory extensions
  mfnetworkid: string;           // Required: operator network ID
  mfcorrelationid?: string;      // Links cue → process → result chain
  mfcausationid?: string;        // Event that triggered this cue
  mfsequence?: number;           // Per-source ordering
  mfactor?: {                    // Who/what produced this event
    type: "operator" | "agent" | "system";
    id: string;
  };
  mfsessionid?: string;          // Agent session for Miner provenance

  // Event payload
  data: {
    cueId: string;               // The cue that fired
    cueType: string;             // "event" | "schedule" | "state" | "intent" | "programmatic" | "composed"
    triggerSource: string;       // What triggered evaluation
    bindingTarget?: string;      // Process ID if binding is resolved
    [TO BE CLARIFIED: Additional payload fields needed by Miner/Grove?]
  };
}
```

## Subject Pattern

Per DD-69 and DD-70:
- Subject: `mf.{network_id}.cue.fired`
- Example: `mf.net-andreas.cue.fired`
- Wildcard subscription: `mf.*.cue.fired` (all networks' cue fires)

## Integration Points

| Component | Integration | Direction |
|-----------|-------------|-----------|
| P-500 Transport | Uses `TransportPublisher.publish()` | Outbound |
| P-501 Cue Consumer | Triggered after successful cue evaluation | Internal |
| Miner | Subscribes to `cue.fired` for provenance | Downstream |
| Grove | May relay to Discord/dashboards | Downstream |
| Spawn | Subscribes for execution dispatch (Stage 4) | Downstream |

## Success Criteria

- [ ] `CueFiredPublisher` publishes valid CloudEvents-compliant events
- [ ] Events routed to correct NATS subject `mf.{network_id}.cue.fired`
- [ ] All required CloudEvents fields present: `specversion`, `id`, `source`, `type`, `time`
- [ ] Required extension `mfnetworkid` always populated
- [ ] Unit tests pass using InMemoryTransport (no NATS in test)
- [ ] Integration test with local NATS verifies end-to-end publish
- [ ] TypeScript types exported for consumers (Miner, Grove)
- [ ] [TO BE CLARIFIED: Performance benchmark target (events/second)?]

## Assumptions

1. P-500 transport abstraction is complete and provides `TransportPublisher` interface
2. P-501 cue consumer establishes the cue evaluation trigger point
3. Network ID is available from runtime configuration (same mechanism as P-501)
4. ULID generation library is available or can be added as dependency
5. Cue evaluation logic exists (from P-501 or earlier iteration) — this feature adds publishing, not evaluation

## Open Questions

- [TO BE CLARIFIED] What additional payload fields does Miner require for provenance beyond cueId/cueType/triggerSource?
- [TO BE CLARIFIED] Should `cue.fired` events be persisted in JetStream, or is fire-and-forget acceptable for this event type?
- [TO BE CLARIFIED] Is there a performance target for publish throughput (events/second)?
- [TO BE CLARIFIED] Should failed cue evaluations also publish events (e.g., `cue.evaluation.failed`)?

## References

- DD-62: Cues as ninth artifact type (activation loop, `cue.fired` event)
- DD-68: CloudEvents envelope with metafactory extensions
- DD-69: Transport abstraction layer
- DD-70: Hub-and-spoke federation (subject hierarchy)
- DD-71: Five-stage migration (Stage 1: Pulse local NATS)
- `pulse/design/cue-architecture.md`: Cue system architecture
- `nats-phase1-features.json`: P-502 feature definition
