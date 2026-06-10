# Technical Plan: Transport Abstraction Layer

**Feature ID:** P-500
**Status:** Ready for implementation
**Created:** 2026-04-04

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Consumer Code (Pulse, cortex, etc.)                  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    ┌─────────────────────────────────────────────────────────────────┐       │
│    │                   Transport Interfaces                          │       │
│    │                                                                 │       │
│    │   TransportPublisher          TransportSubscriber               │       │
│    │   ├─ publish(subject, event)  ├─ subscribe(subject, handler)   │       │
│    │   └─ close()                  └─ close()                        │       │
│    └─────────────────────────────────────────────────────────────────┘       │
│                                    │                                         │
│         ┌──────────────────────────┼──────────────────────────┐              │
│         │                          │                          │              │
│         ▼                          ▼                          ▼              │
│  ┌─────────────┐           ┌─────────────┐           ┌─────────────────┐     │
│  │   NATS      │           │  InMemory   │           │   DualWrite     │     │
│  │  Transport  │           │  Transport  │           │   Transport     │     │
│  │             │           │             │           │                 │     │
│  │ Production  │           │   Testing   │           │   Migration     │     │
│  │ @nats-io/*  │           │ EventEmitter│           │ Primary+Secondary│    │
│  └─────────────┘           └─────────────┘           └─────────────────┘     │
│         │                                                   │ │              │
│         ▼                                                   ▼ ▼              │
│  ┌─────────────┐                                     (delegates to           │
│  │ NATS Server │                                      two transports)        │
│  │ + JetStream │                                                             │
│  └─────────────┘                                                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Thin interface** — publish/subscribe and nothing more (DD-69)
2. **Test-first** — InMemoryTransport enables `bun test` without NATS
3. **Same contract everywhere** — all implementations pass identical test suites
4. **Asymmetric dual-write** — primary failures raise, secondary failures warn

---

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Project standard |
| Language | TypeScript (strict) | Type safety, existing codebase |
| NATS client | `@nats-io/transport-node` | Official NATS.js v3 client |
| JetStream | `@nats-io/jetstream` | Durable subscriptions, ack semantics |
| Schema validation | Zod | Existing project pattern |
| Event IDs | ULID | Sortable, unique, no dependencies |
| Testing | `bun:test` | Project standard |

### Package Dependencies

```json
{
  "dependencies": {
    "@nats-io/transport-node": "^3.0.0",
    "@nats-io/jetstream": "^3.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.3.0"
  }
}
```

---

## Data Model

### MetafactoryEvent (CloudEvents v1.0 + mf* extensions)

```typescript
import { z } from "zod";

// CloudEvents base (required fields)
export const CloudEventsBaseSchema = z.object({
  specversion: z.literal("1.0"),
  id: z.string().min(1),                    // ULID recommended
  source: z.string().min(1),                // URI: metafactory://{network_id}/{component}
  type: z.string().min(1),                  // e.g., pulse.process.completed
});

// CloudEvents optional fields
export const CloudEventsOptionalSchema = z.object({
  time: z.string().datetime().optional(),   // ISO 8601
  datacontenttype: z.literal("application/json").optional(),
  dataschema: z.string().url().optional(),  // URI to JSON Schema
  subject: z.string().optional(),           // Event subject for filtering
});

// metafactory extensions
export const MetafactoryExtensionsSchema = z.object({
  mfnetworkid: z.string().min(1),           // Required: operator network ID
  mfcorrelationid: z.string().optional(),   // Links related events
  mfcausationid: z.string().optional(),     // ID of causing event
  mfsequence: z.number().int().optional(),  // Per-source sequence number
  mfactor: z.object({
    type: z.enum(["operator", "agent", "system"]),
    id: z.string(),
  }).optional(),
  mfsessionid: z.string().optional(),       // Agent session for Miner
  mfsignature: z.string().optional(),       // Reserved for signing
});

// Full event schema
export const MetafactoryEventSchema = CloudEventsBaseSchema
  .merge(CloudEventsOptionalSchema)
  .merge(MetafactoryExtensionsSchema)
  .extend({
    data: z.unknown(),                      // Event-specific payload
  });

export type MetafactoryEvent = z.infer<typeof MetafactoryEventSchema>;
```

### Interface Definitions

```typescript
// ---------------------------------------------------------------------------
// Publisher Interface
// ---------------------------------------------------------------------------

export interface TransportPublisher {
  /**
   * Publish an event to a subject.
   * For NATSTransport: uses JetStream publish (acknowledged).
   * For InMemoryTransport: synchronous emit.
   */
  publish(subject: string, event: MetafactoryEvent): Promise<void>;

  /**
   * Close the publisher and release resources.
   * For NATSTransport: drains connection.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Subscriber Interface
// ---------------------------------------------------------------------------

export interface TransportSubscriber {
  /**
   * Subscribe to events on a subject pattern.
   * Supports wildcards: mf.*.cue.fired, mf.{network_id}.>
   */
  subscribe(subject: string, handler: MessageHandler): Promise<Subscription>;

  /**
   * Close the subscriber and release resources.
   */
  close(): Promise<void>;
}

export interface MessageHandler {
  (msg: MetafactoryEvent, controls: AckControls): Promise<void>;
}

export interface AckControls {
  /** Acknowledge successful processing */
  ack(): void;

  /** Negative acknowledge — request redelivery after optional delay (ms) */
  nak(delay?: number): void;

  /** Extend ack deadline for long-running handlers */
  working(): void;
}

export interface Subscription {
  /** Unsubscribe and stop receiving messages */
  unsubscribe(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory Interface
// ---------------------------------------------------------------------------

export interface TransportConfig {
  type: "nats" | "memory" | "dual";
  nats?: NATSConfig;
  dual?: {
    primary: TransportConfig;
    secondary: TransportConfig;
  };
}

export interface NATSConfig {
  servers: string[];              // e.g., ["nats://localhost:4222"]
  name?: string;                  // Client name for debugging
  maxReconnectAttempts?: number;  // Default: -1 (infinite)
  reconnectTimeWait?: number;     // ms between attempts, default: 2000
}

export interface Transport {
  publisher: TransportPublisher;
  subscriber: TransportSubscriber;
}

export function createTransport(config: TransportConfig): Promise<Transport>;
```

---

## Implementation Phases

### Phase 1: Types and Schemas (Day 1)

**Goal:** Define all interfaces and Zod schemas.

| Task | Output |
|------|--------|
| Define MetafactoryEvent Zod schema | `types.ts` |
| Define TransportPublisher interface | `types.ts` |
| Define TransportSubscriber interface | `types.ts` |
| Define AckControls, Subscription, MessageHandler | `types.ts` |
| Define TransportConfig types | `types.ts` |
| Add ULID generation helper | `ulid.ts` |
| Export all types from package index | `index.ts` |

**Tests:** Schema validation tests for MetafactoryEvent (valid, missing fields, invalid specversion).

### Phase 2: InMemoryTransport (Day 1-2)

**Goal:** Enable testing without NATS.

| Task | Output |
|------|--------|
| Implement InMemoryTransport class | `memory.ts` |
| Use Node.js EventEmitter for pub/sub | |
| Implement wildcard subject matching | `wildcards.ts` |
| Implement no-op AckControls | |
| Add createTransport for memory type | `factory.ts` |

**Implementation notes:**
- Use `EventEmitter` for synchronous message delivery
- Wildcard matching: `*` matches one token, `>` matches remaining tokens
- AckControls are no-ops (no durability in memory)
- Events are delivered synchronously for test determinism

**Tests:**
- Basic publish/subscribe round-trip
- Wildcard subscriptions (`mf.*.events`, `mf.network1.>`)
- Multiple subscribers receive same event
- Unsubscribe stops delivery
- Close cleans up

### Phase 3: NATSTransport (Day 2-3)

**Goal:** Production transport with JetStream.

| Task | Output |
|------|--------|
| Implement NATSTransport class | `nats.ts` |
| Connect using @nats-io/transport-node | |
| Publish via JetStream for durability | |
| Subscribe via JetStream consumers | |
| Implement AckControls mapping to NATS | |
| Handle reconnection automatically | |
| Add createTransport for nats type | `factory.ts` |

**Implementation notes:**
- Use `connect()` from `@nats-io/transport-node`
- Get JetStream context via `nc.jetstream()`
- Publisher uses `js.publish(subject, payload)`
- Subscriber creates durable consumers with explicit ack
- AckControls map to NATS: `msg.ack()`, `msg.nak(delay)`, `msg.working()`
- Connection events logged but not surfaced (rely on NATS defaults)

**Tests (integration — require NATS server):**
- Connection establishment
- Publish/subscribe round-trip
- Ack/nak behavior
- Reconnection after disconnect
- Graceful close

### Phase 4: DualWriteTransport (Day 3)

**Goal:** Migration support with asymmetric error handling.

| Task | Output |
|------|--------|
| Implement DualWriteTransport class | `dual.ts` |
| Wrap two TransportPublisher instances | |
| Primary failure → throw | |
| Secondary failure → warn + continue | |
| Subscribe delegates to primary only | |
| Add createTransport for dual type | `factory.ts` |

**Implementation notes:**
- Takes two Transport instances (primary, secondary)
- `publish()`: try both, fail fast on primary error
- Secondary publish wrapped in try/catch with `console.warn`
- Subscribe only wires up primary (dual-write is for publish migration)

**Tests:**
- Both transports receive events
- Primary failure throws
- Secondary failure logs warning but succeeds
- Subscribe only uses primary

### Phase 5: Factory and Package Export (Day 4)

**Goal:** Clean package boundary for consumers.

| Task | Output |
|------|--------|
| Implement createTransport factory | `factory.ts` |
| Validate config with Zod | |
| Export public API from index | `index.ts` |
| Add package.json | `package.json` |
| Add tsconfig.json (extends root) | `tsconfig.json` |
| Document usage in README | `README.md` |

**Public API:**
```typescript
export { createTransport } from "./factory";
export type {
  Transport,
  TransportConfig,
  TransportPublisher,
  TransportSubscriber,
  MessageHandler,
  AckControls,
  Subscription,
  MetafactoryEvent,
  NATSConfig,
} from "./types";
export { MetafactoryEventSchema } from "./types";
export { generateEventId } from "./ulid";
```

---

## File Structure

```
packages/
└── transport/
    ├── package.json              # Package manifest (workspace member)
    ├── tsconfig.json             # Extends ../../tsconfig.json
    ├── README.md                 # Usage documentation
    ├── src/
    │   ├── index.ts              # Public API exports
    │   ├── types.ts              # Interfaces, Zod schemas, MetafactoryEvent
    │   ├── ulid.ts               # ULID generation helper
    │   ├── wildcards.ts          # Subject wildcard matching
    │   ├── factory.ts            # createTransport function
    │   ├── memory.ts             # InMemoryTransport implementation
    │   ├── nats.ts               # NATSTransport implementation
    │   └── dual.ts               # DualWriteTransport implementation
    └── tests/
        ├── types.test.ts         # Schema validation tests
        ├── memory.test.ts        # InMemoryTransport unit tests
        ├── wildcards.test.ts     # Wildcard matching tests
        ├── nats.test.ts          # NATSTransport integration tests
        ├── dual.test.ts          # DualWriteTransport tests
        └── compliance.test.ts    # Interface compliance (all impls)
```

### Root Project Changes

```diff
# package.json — add workspace config
{
  "name": "pulse",
+ "workspaces": ["packages/*"],
  ...
}

# tsconfig.json — add path mapping
{
  "compilerOptions": {
+   "paths": {
+     "@pulse/transport": ["./packages/transport/src"]
+   }
  },
+ "references": [
+   { "path": "./packages/transport" }
+ ]
}
```

---

## Dependencies

### External

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@nats-io/transport-node` | ^3.0.0 | NATS client for Node.js/Bun |
| `@nats-io/jetstream` | ^3.0.0 | JetStream extension |
| `zod` | ^3.22.0 | Schema validation |

### Internal

| Dependency | Notes |
|------------|-------|
| P-103 (PulseRunner) | Existing — transport will emit execution events |

### Development

| Dependency | Purpose |
|------------|---------|
| NATS server | Required for integration tests |

---

## Integration Test Setup

NATSTransport tests require a running NATS server. Two options:

### Option A: Native Install (recommended for CI)

```bash
# macOS
brew install nats-server
nats-server -js  # Start with JetStream

# Linux
curl -sf https://binaries.nats.dev/nats-io/nats-server/v2@latest | sh
./nats-server -js
```

### Option B: Docker

```bash
docker run -d --name nats -p 4222:4222 nats:latest -js
```

### Test Script

```bash
# Run unit tests (no NATS required)
bun test packages/transport/tests/memory.test.ts
bun test packages/transport/tests/wildcards.test.ts

# Run integration tests (NATS required)
bun test packages/transport/tests/nats.test.ts

# Run all transport tests
bun test packages/transport/
```

Integration tests should check for NATS availability and skip gracefully:

```typescript
import { describe, test, beforeAll } from "bun:test";

describe("NATSTransport", () => {
  let natsAvailable = false;

  beforeAll(async () => {
    try {
      const nc = await connect({ servers: "localhost:4222" });
      await nc.close();
      natsAvailable = true;
    } catch {
      console.warn("NATS not available — skipping integration tests");
    }
  });

  test.skipIf(!natsAvailable)("publishes to NATS", async () => {
    // ...
  });
});
```

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| NATS v3 API instability | High | Low | Pin exact versions, integration tests |
| JetStream stream setup complexity | Medium | Medium | Consumer responsibility per spec; document requirements |
| Wildcard matching edge cases | Low | Medium | Port NATS wildcard rules exactly; comprehensive tests |
| Bun + NATS compatibility | Medium | Low | Test early; @nats-io supports Node.js APIs that Bun provides |
| Workspace setup complexity | Low | Low | Follow established Bun workspace patterns |

---

## Open Questions Resolution

### Q1: Connection pooling

**Decision:** Single connection per NATSTransport instance. NATS clients multiplex subjects over one connection efficiently. Pooling adds complexity without measurable benefit at metafactory scale.

**Rationale:** NATS protocol multiplexes subscriptions on a single TCP connection. Multiple publishers can share one NATSTransport instance. If consumers need isolation, they create separate instances.

### Q2: Reconnection strategy

**Decision:** Use `@nats-io` defaults with explicit config surface.

```typescript
const defaults: NATSConfig = {
  maxReconnectAttempts: -1,      // Infinite retries
  reconnectTimeWait: 2000,       // 2s between attempts
};
```

**Rationale:** NATS client has well-tested exponential backoff. Surfacing config options allows operators to tune without us reimplementing.

### Q3: JetStream vs Core NATS

**Decision:** JetStream for publish (acknowledged), Core NATS for subscribe (JetStream consumers handle durability).

**Rationale:**
- `js.publish()` returns a PubAck confirming the message reached the stream
- Consumers are JetStream consumers with explicit ack for at-least-once delivery
- Fire-and-forget via Core NATS loses durability guarantees we need for process events

---

## Success Verification

After implementation, verify:

```bash
# 1. Type check passes
bun run typecheck

# 2. All tests pass (InMemory)
bun test packages/transport/tests/memory.test.ts
bun test packages/transport/tests/wildcards.test.ts
bun test packages/transport/tests/dual.test.ts

# 3. Integration tests pass (NATS running)
bun test packages/transport/tests/nats.test.ts

# 4. Compliance tests pass (all implementations)
bun test packages/transport/tests/compliance.test.ts

# 5. Package exports work
bun -e "import { createTransport, MetafactoryEventSchema } from './packages/transport/src'; console.log('OK')"
```

---

## Implementation Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Types/Schemas | 2-3 hours | None |
| Phase 2: InMemoryTransport | 3-4 hours | Phase 1 |
| Phase 3: NATSTransport | 4-6 hours | Phase 1, NATS server |
| Phase 4: DualWriteTransport | 2-3 hours | Phase 2, Phase 3 |
| Phase 5: Factory/Export | 2-3 hours | All phases |
| **Total** | **13-19 hours** | |

---

## Next Steps After P-500

With transport abstraction in place:

1. **P-501 (CuePublisher)** — Use `TransportPublisher` to emit `cue.fired` events
2. **P-502 (ProcessPublisher)** — Emit `pulse.process.started/completed/failed` events
3. **P-503 (EventSubscriber)** — Subscribe to cue events to trigger process execution

The transport layer is foundational — all NATS integration flows through these interfaces.
