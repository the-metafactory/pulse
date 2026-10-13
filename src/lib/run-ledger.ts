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
  type RunOutcome,
  type Sovereignty,
  type TransportPublisher,
  type TransportSubscriber,
} from "@the-metafactory/myelin";
import { createOutbox } from "@the-metafactory/myelin/outbox";

const runs = new AsyncLocalStorage<boolean>();
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

/** Shared production wiring; tests use a real outbox over InMemoryTransport. */
export function createOutboxRunLedgerPublisher(
  inner: TransportPublisher & TransportSubscriber,
  config: RunLedgerConfig,
  log: (message: string) => void,
): RunLedgerPublisher {
  const outbox = createOutbox({ path: config.path, inner, log });
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
  | { kind: "log" | "error"; message: string };

// Myelin tracks replay claims per process. Workers sharing our PID must use
// the same spool serially, so one cannot adopt another worker's live claim.
const publisherQueues = new Map<string, Promise<void>>();

async function acquirePublisherSlot(path: string, signal: AbortSignal): Promise<() => void> {
  const key = resolve(path);
  const previous = publisherQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const completion = new Promise<void>(done => { release = done; });
  const queued = previous.then(() => completion);
  publisherQueues.set(key, queued);
  void queued.then(() => {
    if (publisherQueues.get(key) === queued) publisherQueues.delete(key);
  });
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
    signal.throwIfAborted();
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function connectPublisher(
  config: RunLedgerConfig,
  log: (message: string) => void,
  signal: AbortSignal,
): Promise<RunLedgerPublisher> {
  signal.throwIfAborted();
  const release = await acquirePublisherSlot(config.path, signal);
  let worker: Worker;
  try {
    signal.throwIfAborted();
    worker = new Worker(new URL(import.meta.url), {
      workerData: { pulseRunLedger: true, config },
    });
  } catch (error) {
    release();
    throw error;
  }
  let pending: { resolve(): void; reject(error: Error): void } | undefined;
  let workerError: Error | undefined;
  let stopped = false;
  let termination: Promise<number> | undefined;
  const stop = () => {
    stopped = true;
    pending?.reject(new Error("run-ledger publisher stopped"));
    return termination ??= worker.terminate().finally(release);
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
    if (reply.kind === "log") log(reply.message);
    else if (reply.kind === "error") fail(new Error(reply.message));
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
    return {
      drained: Promise.resolve(), // Worker awaits the outbox drain before ready.
      publish: async event => {
        signal.throwIfAborted();
        await wait({ kind: "publish", event });
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
    };
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
  const publisher = createOutboxRunLedgerPublisher(transport, config, message => {
    port.postMessage({ kind: "log", message });
  });
  await publisher.drained;
  port.on("message", async (command: { kind: "publish"; event: ExecutionRunFinishedEvent } | { kind: "close" }) => {
    try {
      if (command.kind === "publish") {
        await publisher.publish(command.event);
        port.postMessage({ kind: "published" });
      } else {
        await publisher.close();
        port.postMessage({ kind: "closed" });
      }
    } catch (error) {
      port.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
  port.postMessage({ kind: "ready" });
}

if (!isMainThread && workerData?.pulseRunLedger) {
  void runPublisherWorker(workerData.config).catch(error => {
    parentPort!.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  });
}

interface FinishedRun {
  outcome: RunOutcome;
  startedAt?: string;
  endedAt?: string;
}

async function emitFinished(
  config: RunLedgerConfig,
  factory: RunLedgerPublisherFactory,
  ref: string,
  runId: string,
  startedAt: string,
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
      report(`emit failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (publisher) {
        try {
          await publisher.close();
        } catch (error) {
          report(`close failed: ${error instanceof Error ? error.message : String(error)}`);
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
  if (runs.getStore()) return body();
  const config = readConfig();
  const factory = publisherFactory;
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  return runs.run(true, async () => {
    let finished: FinishedRun = { outcome: "failed" };
    try {
      const result = await body();
      finished = summarize(result);
      return result;
    } finally {
      finished.endedAt ??= new Date().toISOString();
      if (config) await emitFinished(config, factory, ref, runId, startedAt, finished);
    }
  });
}
