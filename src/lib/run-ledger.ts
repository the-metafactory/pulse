import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import {
  createExecutionRunFinished,
  EnvelopeTransport,
  NATSTransport,
  type ExecutionRunFinishedEvent,
  type ExecutionRunServes,
  type MyelinEnvelope,
  type RunOutcome,
  type Sovereignty,
  type TransportPublisher,
  type TransportSubscriber,
} from "@the-metafactory/myelin";
import { createOutbox, type Outbox } from "@the-metafactory/myelin/outbox";

const runs = new AsyncLocalStorage<{ active: boolean }>();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const EMIT_TIMEOUT_MS = 2000;
const sovereignty: Sovereignty = {
  classification: "local",
  data_residency: "CH",
  max_hop: 0,
  frontier_ok: false,
  model_class: "any",
};

export interface RunLedgerConfig {
  principal: string;
  stack: string;
  servers: string;
  credentials?: string;
  path: string;
  correlationId?: string;
  serves?: ExecutionRunServes;
}

export interface RunLedgerPublisher {
  drained: Promise<unknown>;
  publish(event: ExecutionRunFinishedEvent): Promise<void>;
  close(): Promise<void>;
}

export type RunLedgerPublisherFactory = (
  config: RunLedgerConfig,
  log: (message: string) => void,
  signal: AbortSignal,
) => Promise<RunLedgerPublisher>;

let publisherFactory: RunLedgerPublisherFactory = connectPublisher;

/** Swap the publisher at the same seam used by the exported run entry points. */
export function setRunLedgerPublisher(factory: RunLedgerPublisherFactory): () => void {
  const previous = publisherFactory;
  publisherFactory = factory;
  return () => { publisherFactory = previous; };
}

function readConfig(): RunLedgerConfig | undefined {
  const env = process.env;
  const principal = env.PULSE_PRINCIPAL;
  if (!principal) return undefined;
  const goal = env.MF_SERVES_GOAL || undefined;
  const node = env.MF_SERVES_NODE || undefined;
  return {
    principal,
    stack: env.PULSE_STACK || "default",
    servers: env.PULSE_NATS_URL || "localhost:4222",
    credentials: env.PULSE_NATS_CREDS || undefined,
    path: join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pulse", "outbox.jsonl"),
    correlationId: env.MF_CORRELATION_ID || undefined,
    serves: goal || node ? { ...(goal ? { goal } : {}), ...(node ? { node } : {}) } : undefined,
  };
}

function wrapOutboxPublisher(
  outbox: Outbox,
  inner: TransportPublisher & TransportSubscriber,
  config: RunLedgerConfig,
): RunLedgerPublisher {
  const envelopes = new EnvelopeTransport({
    publisher: outbox,
    subscriber: inner,
    networkSovereignty: sovereignty,
    stack: config.stack,
  });
  return {
    drained: outbox.drained,
    publish: ({ subject, input }) => envelopes.publish(input, subject),
    close: () => inner.close(),
  };
}

/** The connection lives in a worker so a stalled native dial can be terminated. */
class RunLedgerTransport extends NATSTransport {
  async connect(): Promise<void> { await this.ensureNc(); }
}

type WorkerReply =
  | { kind: "ready" | "published" | "closed" }
  | { kind: "error"; message: string };

// Keep claims in one isolate and one outbox per spool while runs overlap.
// Otherwise another outbox can replay a put that is still awaiting its ack.
interface Delivery { inner: TransportPublisher; log: (message: string) => void }
const sharedOutboxes = new Map<string, { outbox: Outbox; live: Set<Delivery> }>();
const deliveries = new AsyncLocalStorage<Delivery>();

/** The production per-spool shared outbox over any inner transport; tests pass InMemoryTransport. */
export function createOutboxRunLedgerPublisher(
  inner: TransportPublisher & TransportSubscriber,
  config: RunLedgerConfig,
  log: (message: string) => void,
): RunLedgerPublisher {
  const delivery: Delivery = { inner, log };
  const key = resolve(config.path);
  let shared = sharedOutboxes.get(key);
  if (!shared) {
    const live = new Set<Delivery>();
    // Startup replay runs outside any publish, so it goes through a lease still open.
    // With none left it falls to the creator's closed transport and re-spools.
    const current = () => deliveries.getStore() ?? live.values().next().value ?? delivery;
    shared = {
      live,
      outbox: createOutbox({
        path: key,
        inner: {
          publish: (subject, envelope) => current().inner.publish(subject, envelope),
          request: (subject, envelope, options) => current().inner.request(subject, envelope, options),
          close: () => current().inner.close(),
        },
        log: message => current().log(message),
      }),
    };
    sharedOutboxes.set(key, shared);
  }
  shared.live.add(delivery);
  const lease = shared;
  const publisher = wrapOutboxPublisher(lease.outbox, inner, config);
  return {
    drained: publisher.drained,
    publish: event => deliveries.run(delivery, () => publisher.publish(event)),
    close: async () => {
      try { await publisher.close(); }
      finally {
        lease.live.delete(delivery);
        if (lease.live.size === 0) sharedOutboxes.delete(key);
      }
    },
  };
}

async function connectPublisher(
  config: RunLedgerConfig,
  log: (message: string) => void,
  signal: AbortSignal,
): Promise<RunLedgerPublisher> {
  signal.throwIfAborted();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { pulseRunLedger: true, config },
  });
  let pending: { resolve(): void; reject(error: Error): void } | undefined;
  let workerError: Error | undefined;
  let stopped = false;
  let termination: Promise<number> | undefined;
  const stop = () => {
    stopped = true;
    pending?.reject(new Error("run-ledger publisher stopped"));
    return termination ??= worker.terminate();
  };
  const abort = () => { void stop().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const wait = (command?: unknown) => new Promise<void>((resolve, reject) => {
    pending = { resolve, reject };
    if (workerError) { reject(workerError); return; }
    if (command) {
      try { worker.postMessage(command); }
      catch (error) { reject(error); }
    }
  });
  const fail = (error: Error) => {
    workerError ??= error;
    pending?.reject(error);
  };
  const ready = wait();
  worker.on("message", (reply: WorkerReply) => {
    if (reply.kind === "error") fail(new Error(reply.message));
    else pending?.resolve();
  });
  worker.on("error", error => {
    fail(error instanceof Error ? error : new Error(String(error)));
  });
  worker.on("exit", code => {
    if (!stopped) fail(new Error(`run-ledger publisher exited (${code})`));
  });
  try {
    await ready;
    signal.throwIfAborted();
    const unsupported = async (): Promise<never> => { throw new Error("run-ledger transport only publishes"); };
    return createOutboxRunLedgerPublisher({
      request: unsupported,
      subscribe: unsupported,
      subscribeBestEffort: unsupported,
      publish: async (subject, envelope) => {
        signal.throwIfAborted();
        await wait({ kind: "publish", subject, envelope });
      },
      close: async () => {
        try {
          if (!stopped) {
            await wait({ kind: "close" });
          }
        } finally {
          signal.removeEventListener("abort", abort);
          await stop();
        }
      },
    }, config, log);
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await stop();
    throw error;
  }
}

async function runPublisherWorker(config: RunLedgerConfig): Promise<void> {
  const port = parentPort!;
  const transport = new RunLedgerTransport({
    servers: config.servers,
    credentials: config.credentials,
    requireAuth: Boolean(config.credentials),
    reconnect: false,
    name: "pulse-run-ledger",
  });
  await transport.connect();
  port.on("message", async (command: { kind: "publish"; subject: string; envelope: MyelinEnvelope } | { kind: "close" }) => {
    try {
      if (command.kind === "publish") {
        await transport.publish(command.subject, command.envelope);
        port.postMessage({ kind: "published" });
      } else {
        await transport.close();
        port.postMessage({ kind: "closed" });
      }
    } catch (error) {
      port.postMessage({ kind: "error", message: messageOf(error) });
    }
  });
  port.postMessage({ kind: "ready" });
}

if (!isMainThread && workerData?.pulseRunLedger) {
  void runPublisherWorker(workerData.config).catch(error => {
    parentPort!.postMessage({ kind: "error", message: messageOf(error) });
  });
}

interface FinishedRun {
  outcome: RunOutcome;
  startedAt?: string;
  endedAt?: string;
}

interface RunIdentity {
  ref: string;
  runId: string;
  startedAt: string;
}

async function emitFinished(
  config: RunLedgerConfig,
  factory: RunLedgerPublisherFactory,
  { ref, runId, startedAt }: RunIdentity,
  finished: FinishedRun,
): Promise<void> {
  const controller = new AbortController();
  let failure: string | undefined;
  let settled = false;
  const report = (message: string) => {
    if (!settled) failure ??= message;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      failure = "emit timed out after 2000 ms";
      controller.abort(new Error("run-ledger emit timed out"));
      resolve();
    }, EMIT_TIMEOUT_MS);
  });
  const emit = async () => {
    let publisher: RunLedgerPublisher | undefined;
    try {
      const event = createExecutionRunFinished({
        source: `${config.principal}.pulse.run`,
        principal: config.principal,
        stack: config.stack,
        sovereignty,
        payload: {
          run_id: runId,
          producer: "pulse",
          ran: { kind: "flow", ref },
          outcome: finished.outcome,
          started_at: finished.startedAt ?? startedAt,
          ended_at: finished.endedAt ?? new Date().toISOString(),
          ...(config.correlationId ? { correlation_id: config.correlationId } : {}),
          ...(config.serves ? { serves: config.serves } : {}),
        },
      });
      publisher = await factory(config, report, controller.signal);
      controller.signal.throwIfAborted();
      await publisher.drained;
      controller.signal.throwIfAborted();
      await publisher.publish(event);
    } catch (error) {
      report(`emit failed: ${messageOf(error)}`);
    } finally {
      if (publisher) {
        try {
          await publisher.close();
        } catch (error) {
          report(`close failed: ${messageOf(error)}`);
        }
      }
    }
  };
  try {
    await Promise.race([emit(), deadline]);
  } finally {
    clearTimeout(timer);
    settled = true;
    if (failure) {
      try {
        console.error(`[pulse-run-ledger] ${failure.replace(/[\r\n]+/g, " ")}`);
      } catch {
        // Even a failing stderr sink cannot change execution results.
      }
    }
  }
}

/** One funnel for all execution entry points, including disabled and thrown runs. */
export async function withRunLedger<T>(
  ref: string,
  body: () => Promise<T>,
  summarize: (result: T) => FinishedRun,
): Promise<T> {
  if (runs.getStore()?.active) return body();
  const config = readConfig();
  const factory = publisherFactory;
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const context = { active: true };
  return runs.run(context, async () => {
    let finished: FinishedRun = { outcome: "failed" };
    try {
      const result = await body();
      finished = summarize(result);
      return result;
    } finally {
      finished.endedAt ??= new Date().toISOString();
      try {
        if (config) await emitFinished(config, factory, { ref, runId, startedAt }, finished);
      } finally {
        context.active = false;
      }
    }
  });
}
