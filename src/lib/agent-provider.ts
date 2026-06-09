/**
 * Agent Providers — dispatch agent tasks to the metafactory fleet.
 *
 * MyelinAgentProvider speaks the myelin v3 envelope + subject grammar over a
 * pluggable AgentTransport (in-memory for tests/demos, NATS for the live bus).
 * Pulse never bypasses the bus: there is no direct HTTP or process call to
 * any agent in this module — sovereignty enforcement lives on the bus side.
 *
 * Envelope fields and subject grammar are vendored from the myelin spec
 * (myelin: schemas/envelope.schema.json, specs/namespace.md, F-021 task
 * routing). Cortex agents consume `tasks.*` subjects and publish
 * `dispatch.task.completed|failed` lifecycle envelopes with
 * correlation_id = task_id — that is the contract this provider awaits.
 */

import type { AgentProvider, AgentTaskSpec, AgentTaskResult, AgentSovereignty, AgentDispatchOptions } from "../types/agent";

export type { AgentProvider, AgentTaskSpec, AgentTaskResult, AgentSovereignty, AgentDispatchOptions } from "../types/agent";

// ---------------------------------------------------------------------------
// Transport seam — keeps NATS optional and tests hermetic
// ---------------------------------------------------------------------------

export type TransportHandler = (subject: string, data: string) => void;

export interface AgentTransport {
  publish(subject: string, data: string): Promise<void>;
  /** Subscribe to a subject (supports `*` and `>` wildcards). Returns unsubscribe. */
  subscribe(subject: string, handler: TransportHandler): Promise<() => Promise<void>>;
}

/** Match a concrete subject against a NATS-style pattern (`*` = one token, `>` = rest). */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i; // '>' matches one or more remaining tokens
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/**
 * In-memory transport — same publish/subscribe semantics as NATS core,
 * in-process. Used by tests and the demo's mock fleet; the envelope path
 * is identical to the live bus, only the wire is swapped.
 */
export class InMemoryAgentTransport implements AgentTransport {
  private subs: { pattern: string; handler: TransportHandler }[] = [];

  async publish(subject: string, data: string): Promise<void> {
    // Snapshot so handlers that subscribe/unsubscribe don't mutate mid-loop.
    const matching = this.subs.filter((s) => subjectMatches(s.pattern, subject));
    for (const sub of matching) {
      // Async delivery preserves NATS semantics: publish never re-enters handlers.
      queueMicrotask(() => {
        try {
          sub.handler(subject, data);
        } catch (err) {
          // Isolate a throwing handler so it can't disrupt sibling subscribers
          // (NATS delivers per-subscription; one bad consumer ≠ bus failure).
          console.error(`[pulse:transport] subscription handler threw on '${subject}':`, err);
        }
      });
    }
  }

  async subscribe(pattern: string, handler: TransportHandler): Promise<() => Promise<void>> {
    const entry = { pattern, handler };
    this.subs.push(entry);
    return async () => {
      const idx = this.subs.indexOf(entry);
      if (idx >= 0) this.subs.splice(idx, 1);
    };
  }

  /** Test/demo introspection: number of active subscriptions. */
  get subscriptionCount(): number {
    return this.subs.length;
  }
}

/**
 * NATS transport. The `nats` package is an optional dependency — pulse core
 * stays zero-dep. Connect fails with an actionable message when absent.
 */
interface NatsConnectionLike {
  publish: (subject: string, data: Uint8Array) => void;
  subscribe: (
    subject: string,
    opts: { callback: (err: unknown, msg: { subject: string; data: Uint8Array }) => void },
  ) => { unsubscribe: () => void };
  drain: () => Promise<void>;
}

export class NatsAgentTransport implements AgentTransport {
  private constructor(private nc: NatsConnectionLike) {}

  static async connect(opts: { servers?: string } = {}): Promise<NatsAgentTransport> {
    let natsMod: { connect: (o: { servers: string }) => Promise<unknown> };
    try {
      natsMod = await import("nats");
    } catch (_err) {
      // Optional dependency absent — surface the fix, don't bury the cause.
      throw new Error(
        "NatsAgentTransport requires the 'nats' package (optional dependency). Run: bun add nats",
      );
    }
    const nc = await natsMod.connect({ servers: opts.servers ?? "localhost:4222" });
    return new NatsAgentTransport(nc as NatsConnectionLike);
  }

  async publish(subject: string, data: string): Promise<void> {
    this.nc.publish(subject, new TextEncoder().encode(data));
  }

  async subscribe(pattern: string, handler: TransportHandler): Promise<() => Promise<void>> {
    const sub = this.nc.subscribe(pattern, {
      callback: (err, msg) => {
        if (err) return; // subscription error surfaces via close(), not per-message
        handler(msg.subject, new TextDecoder().decode(msg.data));
      },
    });
    return async () => sub.unsubscribe();
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}

// ---------------------------------------------------------------------------
// Myelin envelope + subject grammar (vendored minimal builder)
// ---------------------------------------------------------------------------

export interface MyelinEnvelope {
  id: string;
  source: string;
  type: string;
  timestamp: string;
  correlation_id?: string;
  sovereignty: Required<Pick<AgentSovereignty, "classification" | "data_residency" | "max_hop" | "frontier_ok" | "model_class">>;
  payload: Record<string, unknown>;
  requirements?: string[];
  distribution_mode?: "offer" | "direct" | "delegate";
  target_assistant?: string;
  deadline?: string;
}

/** Encode a DID for use as a NATS subject segment (myelin#135): `:`→`-`, `.`→`--`. */
export function encodeDidSegment(did: string): string {
  return `@${did.replace(/\./g, "--").replace(/:/g, "-")}`;
}

export interface MyelinAgentProviderConfig {
  transport: AgentTransport;
  /** Principal segment of the subject grammar, e.g. "switch-soc". */
  principal: string;
  /** Stack segment (myelin#113). Default: "default". */
  stack?: string;
  /** Envelope source, fixed 3-segment form `{principal}.{stack}.{assistant}`. Default derived. */
  source?: string;
  /** Sovereignty defaults applied when a task spec omits them. */
  sovereigntyDefaults?: AgentSovereignty;
}

// Safe-by-default base: confidential-until-declared. data_residency is left
// generic ("ZZ" = unknown per ISO 3166 user-assigned) so no deployment-specific
// jurisdiction leaks into the shared codebase — each deployment sets its own
// via `sovereigntyDefaults` (the SOC demo sets "CH").
const SOVEREIGNTY_BASE: Required<AgentSovereignty> = {
  classification: "local",
  data_residency: "ZZ",
  max_hop: 0,
  frontier_ok: false,
  model_class: "local-only",
};

/**
 * Dispatches agent tasks as myelin envelopes and awaits the dispatch
 * lifecycle. Flow: subscribe to dispatch.task.completed|failed → publish
 * task envelope on the offer/direct subject → resolve on matching
 * correlation_id → always unsubscribe.
 */
export class MyelinAgentProvider implements AgentProvider {
  private principal: string;
  private stack: string;
  private source: string;
  private transport: AgentTransport;
  private sovereigntyDefaults: AgentSovereignty;

  constructor(config: MyelinAgentProviderConfig) {
    this.transport = config.transport;
    this.principal = config.principal;
    this.stack = config.stack ?? "default";
    this.source = config.source ?? `${config.principal}.${this.stack}.pulse`;
    this.sovereigntyDefaults = config.sovereigntyDefaults ?? {};
  }

  taskSubject(spec: AgentTaskSpec): string {
    // A capability maps onto subject tokens (dots are the token separator and
    // legal: "soc.triage.email" → ...tasks.soc.triage.email). But NATS
    // wildcards and whitespace would produce a malformed subject that fails
    // opaquely on the wire — reject them at dispatch time instead.
    if (/[*>\s]/.test(spec.capability) || spec.capability.split(".").some((t) => t.length === 0)) {
      throw new Error(
        `agent dispatch: capability '${spec.capability}' is not a valid subject fragment (no wildcards, whitespace, or empty tokens)`,
      );
    }
    const base = `local.${this.principal}.${this.stack}.tasks`;
    const mode = spec.distribution_mode ?? "offer";
    if (mode === "direct" || mode === "delegate") {
      if (!spec.target_assistant) {
        throw new Error(`agent dispatch: distribution_mode '${mode}' requires target_assistant`);
      }
      return `${base}.${encodeDidSegment(spec.target_assistant)}.${spec.capability}`;
    }
    return `${base}.${spec.capability}`;
  }

  buildEnvelope(spec: AgentTaskSpec, taskId: string): MyelinEnvelope {
    const sovereignty = {
      ...SOVEREIGNTY_BASE,
      ...this.sovereigntyDefaults,
      ...spec.sovereignty,
    };
    return {
      id: crypto.randomUUID(),
      source: this.source,
      type: `tasks.${spec.capability}`,
      timestamp: new Date().toISOString(),
      correlation_id: taskId,
      sovereignty,
      payload: {
        task_id: taskId,
        capability: spec.capability,
        prompt: spec.prompt,
        ...(spec.input ? { input: spec.input } : {}),
      },
      requirements: [spec.capability],
      distribution_mode: spec.distribution_mode ?? "offer",
      ...(spec.target_assistant ? { target_assistant: spec.target_assistant } : {}),
      ...(spec.timeout_ms ? { deadline: new Date(Date.now() + spec.timeout_ms).toISOString() } : {}),
    };
  }

  async dispatch(spec: AgentTaskSpec, opts: AgentDispatchOptions = {}): Promise<AgentTaskResult> {
    const taskId = crypto.randomUUID();
    const startedAt = Date.now();
    const envelope = this.buildEnvelope(spec, taskId);
    const subject = this.taskSubject(spec);
    const lifecyclePattern = `local.${this.principal}.${this.stack}.dispatch.task.*`;

    if (opts.signal?.aborted) {
      throw new Error(`agent dispatch aborted before publish (task ${taskId})`);
    }

    let unsubscribe: (() => Promise<void>) | null = null;
    let abortListener: (() => void) | null = null;

    try {
      const result = await new Promise<AgentTaskResult>((resolve, reject) => {
        // Subscribe BEFORE publishing — no completion window is lost.
        this.transport
          .subscribe(lifecyclePattern, (subj, data) => {
            const state = subj.split(".").pop();
            if (state !== "completed" && state !== "failed") return;
            let lifecycle: MyelinEnvelope;
            try {
              lifecycle = JSON.parse(data) as MyelinEnvelope;
            } catch (_err) {
              return; // foreign traffic on the lifecycle subject — not ours, skip
            }
            if (lifecycle.correlation_id !== taskId) return;

            const p = lifecycle.payload ?? {};
            resolve({
              task_id: taskId,
              status: state === "completed" ? "completed" : "failed",
              output: p.output ?? p.result ?? null,
              error: state === "failed" ? String(p.error ?? p.reason ?? "agent task failed") : undefined,
              duration_ms: Date.now() - startedAt,
              agent: typeof p.agent_id === "string" ? p.agent_id : undefined,
              model: typeof p.model === "string" ? p.model : undefined,
            });
          })
          .then((unsub) => {
            unsubscribe = unsub;
            if (opts.signal) {
              abortListener = () => reject(new Error(`agent dispatch aborted (task ${taskId})`));
              opts.signal.addEventListener("abort", abortListener, { once: true });
              if (opts.signal.aborted) abortListener();
            }
            return this.transport.publish(subject, JSON.stringify(envelope));
          })
          .then(() => {
            // Task is on the wire — report the real id so observers can correlate.
            opts.onDispatched?.({ task_id: taskId });
          })
          .catch(reject);
      });
      return result;
    } finally {
      if (abortListener && opts.signal) opts.signal.removeEventListener("abort", abortListener);
      if (unsubscribe) await (unsubscribe as () => Promise<void>)();
    }
  }
}

// ---------------------------------------------------------------------------
// Mock provider — unit tests and offline fallbacks
// ---------------------------------------------------------------------------

export interface MockAgentScript {
  /** Result output keyed by capability. Functions receive the spec. */
  [capability: string]: unknown | ((spec: AgentTaskSpec) => unknown);
}

/** Scripted provider: returns canned results by capability. No bus involved. */
export class MockAgentProvider implements AgentProvider {
  public dispatched: AgentTaskSpec[] = [];

  constructor(
    private script: MockAgentScript,
    private opts: { delayMs?: number; failCapabilities?: string[] } = {},
  ) {}

  async dispatch(spec: AgentTaskSpec, dispatchOpts: AgentDispatchOptions = {}): Promise<AgentTaskResult> {
    this.dispatched.push(spec);
    const taskId = crypto.randomUUID();
    const startedAt = Date.now();
    dispatchOpts.onDispatched?.({ task_id: taskId });

    if (this.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.opts.delayMs);
        dispatchOpts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error(`agent dispatch aborted (task ${taskId})`));
          },
          { once: true },
        );
      });
    }
    if (dispatchOpts.signal?.aborted) {
      throw new Error(`agent dispatch aborted (task ${taskId})`);
    }

    if (this.opts.failCapabilities?.includes(spec.capability)) {
      return {
        task_id: taskId,
        status: "failed",
        output: null,
        error: `mock failure for capability ${spec.capability}`,
        duration_ms: Date.now() - startedAt,
      };
    }

    const entry = this.script[spec.capability];
    if (entry === undefined) {
      return {
        task_id: taskId,
        status: "failed",
        output: null,
        error: `no mock script for capability ${spec.capability}`,
        duration_ms: Date.now() - startedAt,
      };
    }

    const output = typeof entry === "function" ? (entry as (s: AgentTaskSpec) => unknown)(spec) : entry;
    return {
      task_id: taskId,
      status: "completed",
      output,
      duration_ms: Date.now() - startedAt,
      agent: "mock",
      model: "mock",
    };
  }
}
