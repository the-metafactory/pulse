# Specification: Transport Abstraction Layer

**Feature ID:** P-500
**Status:** Draft
**Created:** 2026-04-04
**Design Decisions:** DD-67, DD-68, DD-69

---

## Overview

A shared transport abstraction layer (`packages/transport/`) providing a thin interface over publish/subscribe operations. This is the foundation for all NATS-based communication in the metafactory ecosystem, enabling Pulse, Grove, Spawn, and Miner to publish and subscribe to events without coupling to a specific transport implementation.

The abstraction enables:
- **Production use** via NATS + JetStream
- **Unit testing** without external processes (in-memory transport)
- **Safe migration** via dual-write capability during transport transitions

Per DD-69: this is NOT a generic "event bus framework" — it wraps publish/subscribe and nothing more.

---

## User Scenarios

### Scenario 1: Publishing process events to NATS

- **Given** a Pulse process execution has completed
- **When** Pulse calls `publisher.publish(subject, event)` with a `MetafactoryEvent`
- **Then** the event is published to the NATS subject `mf.{network_id}.pulse.process.completed`
- **And** the event conforms to the CloudEvents v1.0 envelope with mf* extensions

### Scenario 2: Subscribing to cue events

- **Given** Pulse has initialized a `TransportSubscriber` for cue events
- **When** a cue event is published to `mf.{network_id}.cue.fired`
- **Then** Pulse's subscription handler receives the event
- **And** the handler can acknowledge, negatively acknowledge, or let the message time out

### Scenario 3: Running unit tests without NATS

- **Given** a developer runs `bun test` without a NATS server running
- **When** tests instantiate `InMemoryTransport`
- **Then** publish/subscribe operations work in-process via EventEmitter
- **And** tests can verify event flow without external dependencies

### Scenario 4: Migration dual-write

- **Given** an operator is migrating from JSONL traces to NATS
- **When** they configure `DualWriteTransport` with NATS as primary and JSONL as secondary
- **Then** events are written to both transports
- **And** primary (NATS) failures raise errors
- **And** secondary (JSONL) failures log warnings but do not fail the operation

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-1 | Define `TransportPublisher` interface with `publish(subject: string, event: MetafactoryEvent): Promise<void>` and `close(): Promise<void>` | High | Core abstraction |
| FR-2 | Define `TransportSubscriber` interface with `subscribe(subject: string, handler: MessageHandler): Promise<Subscription>` and `close(): Promise<void>` | High | Core abstraction |
| FR-3 | Implement `NATSTransport` wrapping `@nats-io/transport-node` + `@nats-io/jetstream` | High | Production transport |
| FR-4 | Implement `InMemoryTransport` using Node.js `EventEmitter` for testing | High | Enables `bun test` without NATS |
| FR-5 | Implement `DualWriteTransport` that publishes to primary and secondary transports | Medium | Migration support |
| FR-6 | Define `MetafactoryEvent` type conforming to CloudEvents v1.0 with mf* extensions per DD-68 | High | Shared event envelope |
| FR-7 | `DualWriteTransport` must fail on primary failure and warn on secondary failure | Medium | Asymmetric error handling |
| FR-8 | Subscriptions must support wildcard subjects (e.g., `mf.*.cue.fired`, `mf.{network_id}.>`) | High | NATS routing patterns |
| FR-9 | Message handlers must receive acknowledgment controls (`ack()`, `nak()`, `working()`) | High | JetStream consumer semantics |
| FR-10 | Export package from `packages/transport/` as a shared dependency | High | Consumed by all ecosystem components |

---

## MetafactoryEvent Type (DD-68)

The event envelope follows CloudEvents v1.0 specification with metafactory extensions:

### Required CloudEvents Fields

| Field | Type | Description |
|-------|------|-------------|
| `specversion` | `"1.0"` | CloudEvents spec version |
| `id` | `string` | Unique event ID (ULID recommended) |
| `source` | `string` | URI: `metafactory://{network_id}/{component}` |
| `type` | `string` | Hierarchical event type: `grove.agent.task.completed`, `cue.fired`, `pulse.process.completed` |

### Optional CloudEvents Fields

| Field | Type | Description |
|-------|------|-------------|
| `time` | `string` | ISO 8601 timestamp |
| `datacontenttype` | `string` | Always `"application/json"` |
| `dataschema` | `string` | URI to JSON Schema (optional) |
| `subject` | `string` | Event subject for filtering |

### metafactory Extensions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mfnetworkid` | `string` | **Yes** | Operator network ID |
| `mfcorrelationid` | `string` | No | Links related events across cue->process->result |
| `mfcausationid` | `string` | No | ID of event that caused this one |
| `mfsequence` | `number` | No | Per-source sequence number for ordering |
| `mfactor` | `object` | No | `{ type: "operator" \| "agent" \| "system", id: string }` |
| `mfsessionid` | `string` | No | Agent session for Miner provenance |
| `mfsignature` | `string` | No | Reserved for cryptographic signing (not implemented) |

### Event Data

| Field | Type | Description |
|-------|------|-------------|
| `data` | `unknown` | Event-specific payload |

---

## In Scope

- `TransportPublisher` and `TransportSubscriber` interfaces
- Three implementations: `NATSTransport`, `InMemoryTransport`, `DualWriteTransport`
- `MetafactoryEvent` type (CloudEvents v1.0 + mf* extensions)
- `createTransport()` factory function
- Shared package at `packages/transport/`
- Unit tests (InMemory) and integration tests (NATS)

## Error Handling

| Error State | Behavior | Recovery |
|-------------|----------|----------|
| NATS connection refused | `NATSTransport.publish()` rejects with `TransportConnectionError` | Caller decides retry; transport does not retry internally |
| NATS connection lost mid-session | Relies on `@nats-io` auto-reconnect (default: 10 retries, 2s backoff) | Events during disconnect buffer up to 8MB (NATS default); overflow rejects with `TransportBufferOverflowError` |
| Invalid subject (empty, null) | `publish()` rejects synchronously with `TransportValidationError` | Caller must fix input |
| Invalid event (missing required CloudEvents fields) | `publish()` rejects with `TransportValidationError` after Zod parse | Caller must fix event |
| `DualWriteTransport` primary fails | Error propagated to caller | Secondary still attempted; secondary failure logged as warning |
| `DualWriteTransport` secondary fails | Warning logged via `console.warn` | Primary success is sufficient; operation succeeds |
| `InMemoryTransport` handler throws | Error propagated to subscriber | No retry; test should assert on the error |
| `subscribe()` on closed transport | Rejects with `TransportClosedError` | Caller must create new transport instance |
| Concurrent `close()` calls | Idempotent — second call resolves immediately | No error |

### Edge Cases

- **Empty subject string**: Rejected at validation layer before reaching NATS
- **Event with unknown extension fields**: Passed through (CloudEvents allows extensions)
- **Subscription to subject with no publishers**: Valid — handler simply never fires
- **Multiple subscriptions to same subject**: Each gets independent delivery
- **Publish after close**: Rejected with `TransportClosedError`

## Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Package size must remain minimal | ~200 lines of interface + ~150 lines per implementation |
| NFR-2 | Zero external dependencies beyond `@nats-io/*` packages and `zod` | Minimize footprint |
| NFR-3 | `InMemoryTransport` must deliver events synchronously within the same tick for test determinism | `await publish()` → handler fires before next `await` |
| NFR-4 | `NATSTransport` publish latency | < 5ms p99 for local NATS |
| NFR-5 | `NATSTransport` subscribe-to-first-message latency | < 50ms after subscription established |
| NFR-6 | All implementations must pass identical interface compliance test suite | Zero implementation-specific test skips |
| NFR-7 | No sensitive data in error messages | Connection strings, credentials never logged |

---

## Interface Definitions

### TransportPublisher

```typescript
interface TransportPublisher {
  publish(subject: string, event: MetafactoryEvent): Promise<void>;
  close(): Promise<void>;
}
```

### TransportSubscriber

```typescript
interface TransportSubscriber {
  subscribe(subject: string, handler: MessageHandler): Promise<Subscription>;
  close(): Promise<void>;
}

interface MessageHandler {
  (msg: MetafactoryEvent, controls: AckControls): Promise<void>;
}

interface AckControls {
  ack(): void;
  nak(delay?: number): void;
  working(): void;  // Extend ack deadline
}

interface Subscription {
  unsubscribe(): Promise<void>;
}
```

### Transport Factory

```typescript
interface TransportConfig {
  type: "nats" | "memory" | "dual";
  nats?: NATSConfig;
  dual?: {
    primary: TransportConfig;
    secondary: TransportConfig;
  };
}

function createTransport(config: TransportConfig): {
  publisher: TransportPublisher;
  subscriber: TransportSubscriber;
};
```

---

## Success Criteria

- [ ] `TransportPublisher` and `TransportSubscriber` interfaces defined and exported
- [ ] `NATSTransport` connects to NATS server and publishes/subscribes successfully
- [ ] `InMemoryTransport` enables full publish/subscribe in `bun test` without NATS
- [ ] `DualWriteTransport` publishes to both transports with correct error semantics
- [ ] `MetafactoryEvent` type matches DD-68 CloudEvents envelope specification
- [ ] All three implementations pass the same interface compliance test suite
- [ ] Package exports from `packages/transport/` with TypeScript types
- [ ] Integration test confirms round-trip publish/subscribe via NATS
- [ ] Unit tests pass with `bun test` (no external processes required)

---

## Assumptions

1. NATS server is available for integration tests (can be local via Docker or native install)
2. `@nats-io/transport-node` and `@nats-io/jetstream` packages are stable and suitable for production
3. JetStream is required for durable subscriptions with acknowledgment semantics
4. The package will be consumed by Grove, Spawn, and Miner in future iterations

---

## Out of Scope

- Authentication and account configuration (DD-72 — handled by NATS server config)
- JetStream stream creation and management (consumer responsibility)
- Message serialization beyond JSON (always `application/json`)
- Retry logic within the transport layer (consumer responsibility)
- Cryptographic signing (`mfsignature` reserved but not implemented per DD-68)

---

## Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| P-103 (PulseRunner) | Internal | Foundation for execution events |
| `@nats-io/transport-node` | External | NATS client library |
| `@nats-io/jetstream` | External | JetStream extension |
| Zod | External | Schema validation for MetafactoryEvent |

---

## Open Questions

[TO BE CLARIFIED] **Connection pooling:** Should `NATSTransport` maintain a single connection or support connection pools for high-throughput scenarios?

[TO BE CLARIFIED] **Reconnection strategy:** What backoff strategy should `NATSTransport` use for automatic reconnection? Rely on `@nats-io` defaults or configure explicitly?

[TO BE CLARIFIED] **JetStream vs Core NATS:** Should `publish()` use JetStream publish (with acknowledgment) or Core NATS publish (fire-and-forget)? Current assumption: JetStream for durability.
