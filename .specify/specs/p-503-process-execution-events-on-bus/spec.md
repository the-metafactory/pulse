# Specification: Process Execution Events on Bus

## Overview

P-503 enables Pulse to publish process execution lifecycle events to NATS, making Flow executions observable across the metafactory ecosystem. When a Flow starts, completes, or fails, Pulse emits a CloudEvents-formatted message to the NATS bus following the subject pattern `mf.{network_id}.pulse.process.{started|completed|failed}`.

**Primary consumers:**
- **Miner** — captures traces for process mining and observability
- **cortex** — surfaces execution status in Mission Control

**Dependency:** P-502 (Cue.fired event publisher) — the transport abstraction (P-500) and NATS connection are already available.

## User Scenarios

### Scenario 1: Flow Execution Visibility in cortex Mission Control

- **Given** a user has the cortex Mission Control dashboard open showing process activity
- **When** a Flow is triggered (manually, via cue, or on schedule)
- **Then** cortex receives `pulse.process.started` and displays the Flow as "running"
- **And** when the Flow completes, cortex receives `pulse.process.completed` and updates status to "done"

### Scenario 2: Miner Trace Capture

- **Given** Miner is subscribed to `mf.{network_id}.pulse.process.>` for trace collection
- **When** a Flow executes (success or failure)
- **Then** Miner captures the started/completed/failed events with timing and context
- **And** Miner can correlate these events with `cue.fired` events from P-502

### Scenario 3: Failed Flow Alerting

- **Given** an operator has configured alerting on `pulse.process.failed` events
- **When** a Flow fails due to source, pipeline, or destination error
- **Then** a `pulse.process.failed` event is published containing error details and failed stage
- **And** the alerting system can route based on event attributes

### Scenario 4: Local Development Without NATS

- **Given** a developer is running Pulse locally with InMemoryTransport (no NATS)
- **When** a Flow executes
- **Then** process events are emitted to the in-memory transport (no external dependency)
- **And** tests can verify event emission without NATS infrastructure

## Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Publish `pulse.process.started` event when Flow execution begins | High |
| FR-2 | Publish `pulse.process.completed` event when Flow execution succeeds | High |
| FR-3 | Publish `pulse.process.failed` event when Flow execution fails (any stage) | High |
| FR-4 | Use CloudEvents v1.0 envelope with `mf*` extensions per DD-68 | High |
| FR-5 | Use subject pattern `mf.{network_id}.pulse.process.{action}` per DD-69 | High |
| FR-6 | Include Flow metadata (name, source type, pipeline name) in event payload | High |
| FR-7 | Include timing information (startedAt, completedAt, durationMs) | Medium |
| FR-8 | Include error context in failed events (error message, failedStage) | High |
| FR-9 | Support DualWriteTransport for gradual migration scenarios | Medium |
| FR-10 | Work with InMemoryTransport for testing without NATS | Medium |

## Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Event publication should not block Flow execution | <10ms overhead |
| NFR-2 | Event publication failures should be logged but not fail the Flow | Fire-and-forget |
| NFR-3 | Events must be idempotent-safe (consumers may receive duplicates per DD-71) | At-least-once delivery |

## Event Schemas

### CloudEvents Envelope (DD-68)

All events follow CloudEvents v1.0 spec with metafactory extensions:

```typescript
interface MetafactoryEvent<T> {
  // CloudEvents required attributes
  specversion: "1.0";
  id: string;              // UUID
  source: string;          // e.g., "pulse/{network_id}"
  type: string;            // e.g., "mf.pulse.process.started"
  time: string;            // ISO 8601

  // CloudEvents optional attributes
  datacontenttype: "application/json";

  // mf* extensions (DD-68)
  mfnetworkid: string;     // Network identifier
  mfcorrelationid?: string; // Links related events (e.g., cue → process)

  // Event payload
  data: T;
}
```

### Event Payloads

**pulse.process.started:**
```typescript
{
  flowName: string;
  sourceType: "rss" | "webhook" | "file" | "inline" | "custom";
  pipelineName: string;
  mode: "local" | "cloud";
  startedAt: string;       // ISO 8601
  triggeredBy?: {
    type: "cue" | "schedule" | "manual";
    cueId?: string;        // If triggered by cue
  };
}
```

**pulse.process.completed:**
```typescript
{
  flowName: string;
  sourceType: string;
  pipelineName: string;
  mode: "local" | "cloud";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  destinationWritten: boolean;
}
```

**pulse.process.failed:**
```typescript
{
  flowName: string;
  sourceType: string;
  pipelineName: string;
  mode: "local" | "cloud";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  failedStage: "source" | "pipeline" | "destination";
  error: string;
}
```

## Subject Hierarchy (DD-69)

```
mf.{network_id}.pulse.process.started
mf.{network_id}.pulse.process.completed
mf.{network_id}.pulse.process.failed
```

Consumers can subscribe to:
- `mf.{network_id}.pulse.process.>` — all process events for a network
- `mf.*.pulse.process.failed` — all failures across networks (for ops alerting)

## Integration Points

| System | Role | Subject Pattern |
|--------|------|-----------------|
| Miner | Consumer | `mf.{network_id}.pulse.process.>` |
| cortex | Consumer | `mf.{network_id}.pulse.process.>` |
| Pulse | Publisher | Uses TransportPublisher from P-500 |

## Success Criteria

- [ ] `runFlow()` publishes `started` event before execution begins
- [ ] `runFlow()` publishes `completed` event on success with timing
- [ ] `runFlow()` publishes `failed` event on failure with error context
- [ ] Events conform to CloudEvents v1.0 with mf* extensions
- [ ] Unit tests verify event emission via InMemoryTransport
- [ ] Integration test verifies NATS publication (can use nats-server locally)
- [ ] Event publication does not block Flow execution (fire-and-forget)

## Assumptions

1. P-500 transport abstraction is complete and provides `TransportPublisher`
2. P-502 establishes the pattern for CloudEvents emission that P-503 follows
3. `network_id` is available from runtime configuration (e.g., environment variable or config file)
4. Miner and cortex are already subscribed to the appropriate subjects (out of scope for this feature)

## Open Questions

- [TO BE CLARIFIED] Should `pulse.process.*` events also be emitted for Pipeline executions (not wrapped in a Flow), or only for Flows?
- [TO BE CLARIFIED] What is the source of `network_id` at runtime? Environment variable (`MF_NETWORK_ID`), config file, or passed as parameter?
- [TO BE CLARIFIED] Should there be a configuration flag to disable event emission (e.g., for batch processing scenarios where events would be excessive)?

## Out of Scope

- Miner subscription and trace storage (Miner's responsibility)
- Mission Control rendering (cortex's responsibility)
- Tree-level node events (existing EventEmitter pattern, separate concern)
- Retry/dead-letter handling for failed event publication (Stage 2)
