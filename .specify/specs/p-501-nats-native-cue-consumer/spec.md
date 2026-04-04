# Specification: P-501 NATS-native Cue Consumer

## Overview

Pulse subscribes to cue events from the NATS message bus, enabling external triggers to initiate process execution. This feature establishes Pulse as the first NATS consumer in the metafactory ecosystem, receiving cue events via JetStream and preparing them for downstream evaluation.

**Scope boundary:** This feature builds the receiving infrastructure (subscription interfaces, JetStream consumer, mock emitter for testing). The cue evaluation logic that interprets received cues and decides whether to fire them is explicitly out of scope—that belongs to the cue evaluator subsystem.

**Key design decisions:**
- DD-67: NATS + JetStream as the ecosystem message broker
- DD-68: CloudEvents v1.0 envelope with `mf*` extensions
- DD-69: Transport abstraction layer (provided by P-500)
- DD-72: NATS accounts enforced from Stage 1

## User Scenarios

### Scenario 1: Receive Cue Event from Bus

**Given** Pulse is running with NATS transport configured
**And** a JetStream consumer `pulse-cue-eval` is active on subject `mf.{network_id}.cue.>`
**When** a cue event is published to `mf.local.cue.schedule.daily-digest`
**Then** Pulse receives the event via the subscription handler
**And** the event is acknowledged explicitly after handler completes
**And** the event conforms to CloudEvents envelope (DD-68)

### Scenario 2: Handle Transient Delivery Failure

**Given** Pulse is subscribed to cue events
**When** the subscription handler throws an error (e.g., temporary downstream unavailability)
**Then** the message is NAK'd with backoff
**And** JetStream redelivers after the backoff period
**And** the redelivery count is tracked (MaxDeliver policy)

### Scenario 3: Run Tests Without Live NATS

**Given** a developer is running `bun test`
**And** no NATS server is running
**When** tests exercise the cue consumer
**Then** the mock cue emitter provides synthetic cue events
**And** all consumer logic is testable in isolation
**And** tests pass without external dependencies

### Scenario 4: Filter by Network ID

**Given** Pulse is configured with `network_id: "operator-abc"`
**When** events are published to both `mf.operator-abc.cue.>` and `mf.other-network.cue.>`
**Then** Pulse only receives events matching its configured network ID
**And** cross-network events are not delivered to this consumer

### Scenario 5: Consumer Reconnection After Disconnect

**Given** Pulse has an active cue subscription
**When** the NATS connection is temporarily lost
**And** the connection is restored
**Then** the JetStream consumer resumes from the last acknowledged position
**And** no cue events are lost (durable consumer)
**And** no duplicate processing occurs for already-acknowledged events

## Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Implement `CueSubscriber` interface that wraps P-500's `TransportSubscriber` for cue-specific semantics | High |
| FR-2 | Configure JetStream consumer named `pulse-cue-eval` with subject filter `mf.{network_id}.cue.>` | High |
| FR-3 | Use `AckExplicit` acknowledge policy—handler must explicitly ack/nak each message | High |
| FR-4 | Implement backoff strategy for NAK'd messages (exponential backoff with jitter) | High |
| FR-5 | Parse incoming messages as CloudEvents (DD-68) and validate required fields (`type`, `source`, `id`, `mfnetworkid`) | High |
| FR-6 | Expose received cue events via callback handler: `onCueEvent(event: CueEvent): Promise<void>` | High |
| FR-7 | Implement `MockCueEmitter` for testing that publishes synthetic cue events to InMemoryTransport | High |
| FR-8 | Support graceful shutdown: drain pending messages, close subscription, release consumer | Medium |
| FR-9 | Track consumer metrics: events received, events acked, events nak'd, redelivery count | Medium |
| FR-10 | Validate consumer is durable (survives Pulse restarts, resumes from last position) | Medium |

## Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Cold start time (subscription active) | < 500ms after NATS connection established |
| NFR-2 | Event processing latency (receive to handler invocation) | < 10ms p99 |
| NFR-3 | Memory overhead per subscription | < 5MB |
| NFR-4 | Test suite execution without NATS | `bun test` passes in < 30s with no external deps |
| NFR-5 | Reconnection time after network partition | < 5s to resume consuming |

## Technical Constraints

### JetStream Consumer Configuration

```typescript
// Consumer configuration for pulse-cue-eval
{
  name: "pulse-cue-eval",
  durable_name: "pulse-cue-eval",
  filter_subject: `mf.${networkId}.cue.>`,
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.New, // Only new messages, not replay
  max_deliver: 5,                    // Max redelivery attempts
  ack_wait: 30_000,                  // 30s ack timeout
  backoff: [1000, 5000, 15000, 30000, 60000], // Exponential backoff (ms)
}
```

### CloudEvents Envelope (DD-68)

Received cue events must conform to:

```typescript
interface CueEvent {
  // CloudEvents required fields
  specversion: "1.0";
  type: string;           // e.g., "mf.cue.schedule", "mf.cue.event", "mf.cue.state"
  source: string;         // URI of the cue definition
  id: string;             // Unique event ID (UUID)
  time: string;           // ISO 8601 timestamp

  // Metafactory extensions (DD-68)
  mfnetworkid: string;    // Required: operator network ID
  mfcorrelationid?: string; // Optional: for tracing
  mfcausationid?: string;   // Optional: parent event ID

  // Cue-specific payload
  data: {
    cueId: string;        // Reference to cue artifact
    condition: unknown;   // Cue condition that matched (opaque to consumer)
    matchedAt: string;    // When the condition was satisfied
  };
}
```

### Dependency on P-500

This feature consumes interfaces from P-500 (Transport abstraction layer):

- `TransportSubscriber.subscribe(subject, handler, options)`
- `NATSTransport` for production use
- `InMemoryTransport` for testing

## Interface Design

### CueSubscriber

```typescript
interface CueSubscriberOptions {
  networkId: string;
  onCueEvent: (event: CueEvent) => Promise<void>;
  onError?: (error: Error, event?: CueEvent) => void;
}

interface CueSubscriber {
  /** Start consuming cue events */
  start(): Promise<void>;

  /** Stop consuming (graceful drain) */
  stop(): Promise<void>;

  /** Check if actively consuming */
  isActive(): boolean;

  /** Get consumer metrics */
  metrics(): CueConsumerMetrics;
}

interface CueConsumerMetrics {
  eventsReceived: number;
  eventsAcked: number;
  eventsNakd: number;
  redeliveries: number;
  lastEventAt: string | null;
}
```

### MockCueEmitter

```typescript
interface MockCueEmitter {
  /** Emit a synthetic cue event for testing */
  emit(event: Partial<CueEvent>): Promise<void>;

  /** Emit multiple events in sequence */
  emitSequence(events: Partial<CueEvent>[]): Promise<void>;

  /** Generate a valid cue event with defaults */
  createEvent(overrides?: Partial<CueEvent>): CueEvent;

  /** Get count of emitted events */
  emittedCount(): number;

  /** Clear emission history */
  reset(): void;
}
```

## Success Criteria

- [ ] `CueSubscriber` implementation consumes from `mf.{network_id}.cue.>` via JetStream
- [ ] Consumer uses `AckExplicit` with configurable backoff strategy
- [ ] Received events are validated against CloudEvents schema (DD-68)
- [ ] `MockCueEmitter` enables full test coverage without live NATS
- [ ] `bun test` passes with 100% of cue consumer tests using InMemoryTransport
- [ ] Integration tests (`bun test:integration`) verify behavior with live NATS
- [ ] Consumer survives Pulse restart and resumes from last acknowledged position
- [ ] Metrics are exposed for observability (events received/acked/nak'd)
- [ ] Graceful shutdown drains pending work within 5 seconds

## Assumptions

1. P-500 (Transport abstraction layer) is complete and provides `TransportSubscriber` interface
2. Local NATS server is configured per iteration-7.md with JetStream enabled and `METAFACTORY` stream created
3. NATS accounts are configured from day one (DD-72)—credentials available at `~/.config/nats/creds/pulse.creds`
4. The cue evaluator (not part of this feature) will call `CueSubscriber.start()` and provide the `onCueEvent` handler

## Out of Scope

- **Cue evaluation logic**: Interpreting cue conditions, determining whether to fire—handled by separate cue evaluator
- **Cue.fired event publishing**: Covered by P-502
- **Process execution events**: Covered by P-503
- **Cross-network cue routing**: Stage 4 concern (S-025)
- **Consumer-side idempotency**: Not needed for cue receipt (idempotency is needed for cue.fired dispatch in Spawn)

## Open Questions

[TO BE CLARIFIED] **Backoff configuration**: Should backoff intervals be configurable per-deployment, or fixed at ecosystem level? Current spec proposes fixed intervals matching JetStream defaults.

[TO BE CLARIFIED] **Error handling granularity**: When `onCueEvent` handler throws, should we distinguish between transient errors (retry via NAK) and permanent errors (move to DLQ)? Current spec treats all handler errors as transient.

[TO BE CLARIFIED] **Metrics export format**: Should metrics be exposed via callback, polling interface, or integration with a metrics system (e.g., Prometheus-compatible)? Current spec proposes a simple polling interface.
