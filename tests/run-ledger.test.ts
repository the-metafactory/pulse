import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvelope,
  createExecutionRunFinished,
  InMemoryTransport,
  validateExecutionRunFinished,
  type ExecutionRunFinishedEvent,
  type MyelinEnvelope,
  type Sovereignty,
} from "@the-metafactory/myelin";
import { runFlow, scheduleFlow } from "../src/lib/flow";
import { runPipeline } from "../src/lib/pipeline";
import { PulseRunner } from "../src/lib/runner";
import {
  createOutboxRunLedgerPublisher,
  setRunLedgerPublisher,
  type RunLedgerConfig,
  type RunLedgerPublisher,
} from "../src/lib/run-ledger";
import type { FlowDef, FlowResult } from "../src/types/flow";

const envKeys = [
  "PULSE_PRINCIPAL", "PULSE_STACK", "PULSE_NATS_URL", "PULSE_NATS_CREDS",
  "MF_CORRELATION_ID", "MF_SERVES_GOAL", "MF_SERVES_NODE", "XDG_STATE_HOME",
] as const;
let savedEnv: Record<string, string | undefined>;
let restorePublisher: () => void;
let events: ExecutionRunFinishedEvent[];
let configs: RunLedgerConfig[];
let closes: number;
let stderr: ReturnType<typeof spyOn<typeof console, "error">>;
const never = () => new Promise<void>(() => {});
const flow = (overrides: Partial<FlowDef> = {}): FlowDef => ({
  name: "F_LEDGER",
  source: { type: "inline", data: { value: 42 } },
  pipeline: { actions: [] },
  destination: { type: "custom", fn: async () => {} },
  ...overrides,
});
const options = { actionDirs: [] };
const testSovereignty: Sovereignty = {
  classification: "local", data_residency: "CH", max_hop: 0,
  frontier_ok: false, model_class: "any",
};
const readSpool = async (path: string) =>
  (await readFile(path, "utf8")).trim().split("\n").map(row => JSON.parse(row));
/** Leave one unacknowledged put in the spool, as a run that died before its ack would. */
async function seedOldRun(path: string): Promise<{ subject: string; envelope: MyelinEnvelope }> {
  const { subject, input } = createExecutionRunFinished({
    principal: "jc", stack: "default", source: "jc.pulse.run", sovereignty: testSovereignty,
    payload: { run_id: "old-run", producer: "pulse", ran: { kind: "flow", ref: "old-flow" }, outcome: "succeeded", started_at: "2026-10-13T00:00:00Z", ended_at: "2026-10-13T00:00:01Z" },
  });
  const envelope = createEnvelope({ ...input, sovereignty: testSovereignty });
  await writeFile(path, `${JSON.stringify({ op: "put", id: envelope.id, subject, envelope })}\n`);
  return { subject, envelope };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.PULSE_PRINCIPAL = "jc";
  events = [];
  configs = [];
  closes = 0;
  stderr = spyOn(console, "error").mockImplementation(() => {});
  restorePublisher = setRunLedgerPublisher(async config => {
    configs.push(config);
    return {
      drained: Promise.resolve(),
      publish: async event => { events.push(event); },
      close: async () => { closes++; },
    };
  });
});

afterEach(() => {
  restorePublisher();
  stderr.mockRestore();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function payload(index = 0) {
  return events[index]!.input.payload;
}

function checkFlowTimes(result: FlowResult) {
  expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(Date.parse(result.startedAt)).toBeLessThanOrEqual(Date.parse(result.completedAt));
  expect(payload().started_at).toBe(result.startedAt);
  expect(payload().ended_at).toBe(result.completedAt);
}

describe("run-ledger through exported run entry points", () => {
  test("one valid flow envelope, exact timestamps, and a fresh run UUID", async () => {
    const result = await runFlow(flow(), options);
    expect(result.success).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.subject).toBe("local.jc.default.execution.run.finished");
    expect(events[0]!.input.source).toBe("jc.pulse.run");
    expect(events[0]!.input.type).toBe("execution.run.finished");
    expect(events[0]!.input.sovereignty).toEqual(testSovereignty);
    expect(payload().producer).toBe("pulse");
    expect(payload().ran).toEqual({ kind: "flow", ref: "F_LEDGER" });
    expect(payload().outcome).toBe("succeeded");
    expect(payload()).not.toHaveProperty("detail_ref");
    expect(payload()).not.toHaveProperty("state");
    expect(payload().run_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    checkFlowTimes(result);
    const envelope = createEnvelope({ ...events[0]!.input, sovereignty: testSovereignty });
    expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
    await runFlow(flow(), options);
    expect(events).toHaveLength(2);
    expect(payload(1).run_id).not.toBe(payload().run_id);
    expect(closes).toBe(2);
  });

  for (const stage of ["source", "pipeline", "destination"] as const) {
    test(`one failed envelope on ${stage} failure, with flow start timestamp`, async () => {
      const def = flow(stage === "source" ? {
        source: { type: "custom", fn: async () => { throw new Error("source failed"); } },
      } : stage === "pipeline" ? {
        pipeline: { actions: ["A_MISSING_LEDGER_TEST"] },
      } : {
        destination: { type: "custom", fn: async () => { throw new Error("destination failed"); } },
      });
      const result = await runFlow(def, options);
      expect(result.success).toBe(false);
      expect(result.failedStage).toBe(stage);
      expect(events).toHaveLength(1);
      expect(payload().outcome).toBe("failed");
      checkFlowTimes(result);
    });
  }

  test("pipeline throw path also returns the flow's start timestamp", async () => {
    const error = new Error("pipeline option access failed");
    const throwingOptions = {
      actionDirs: [],
      get mode(): "local" { throw error; },
    };
    const result = await runFlow(flow(), throwingOptions);
    expect(result.failedStage).toBe("pipeline");
    expect(result.error).toBe(error.message);
    expect(events).toHaveLength(1);
    expect(payload().outcome).toBe("failed");
    checkFlowTimes(result);
  });

  for (const success of [true, false]) {
    test(`direct pipeline outcome ${success}`, async () => {
      const result = await runPipeline({ name: "P_LEDGER", actions: success ? [] : ["A_MISSING_LEDGER_TEST"] }, {}, options);
      expect(result.success).toBe(success);
      expect(events).toHaveLength(1);
      expect(payload().ran).toEqual({ kind: "flow", ref: "P_LEDGER" });
      expect(payload().outcome).toBe(success ? "succeeded" : "failed");
    });

    test(`direct runner outcome ${success}`, async () => {
      const runner = new PulseRunner();
      runner.register("a", async () => {
        if (!success) throw new Error("node failed");
        return "ok";
      });
      const result = await runner.run({ id: "tree-ledger", nodes: [{ id: "a", name: "A", retries: 0 }] });
      expect(result.status).toBe(success ? "completed" : "failed");
      expect(events).toHaveLength(1);
      expect(payload().ran).toEqual({ kind: "flow", ref: "tree-ledger" });
      expect(payload().outcome).toBe(success ? "succeeded" : "failed");
      expect(payload().started_at).toBe(result.startedAt.toISOString());
      expect(payload().ended_at).toBe(result.completedAt!.toISOString());
    });
  }

  test("named pipeline load throw emits failure and still throws", async () => {
    await expect(runFlow(flow({ pipeline: "/missing-ledger-pipeline.yaml" }), options)).rejects.toThrow("could not be loaded");
    expect(events).toHaveLength(1);
    expect(payload().outcome).toBe("failed");
  });

  test("invalid tree emits failure and still throws", async () => {
    await expect(new PulseRunner().run({ id: "invalid", nodes: [{ id: "a", name: "A", dependsOn: ["missing"] }] })).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(payload().ran.ref).toBe("invalid");
    expect(payload().outcome).toBe("failed");
  });

  test("exact thrown object survives publishing failure", async () => {
    const restore = setRunLedgerPublisher(async () => { throw new Error("connect failed"); });
    const error = new Error("original runner error");
    const runner = new PulseRunner();
    runner.register("a", async () => 1);
    runner.on("event", () => { throw error; });
    try {
      await expect(runner.run({ id: "throws", nodes: [{ id: "a", name: "A" }] })).rejects.toBe(error);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain("connect failed");
    } finally { restore(); }
  });

  test("nested flows, pipelines, and runners suppress emission across awaits", async () => {
    await runFlow(flow({ source: { type: "custom", fn: async () => {
      await Bun.sleep(1);
      await runFlow(flow({ name: "nested" }), options);
      await runPipeline({ name: "nested-pipeline", actions: [] }, {}, options);
      const runner = new PulseRunner();
      runner.register("a", async () => 1);
      await runner.run({ id: "nested-tree", nodes: [{ id: "a", name: "A" }] });
      return {};
    } } }), options);
    expect(events).toHaveLength(1);
    expect(payload().ran.ref).toBe("F_LEDGER");
    expect(configs).toHaveLength(1);
  });

  test("concurrent top-level runs have separate contexts", async () => {
    await Promise.all([1, 2].map(n => runFlow(flow({
      name: `flow-${n}`,
      source: { type: "custom", fn: async () => { await Bun.sleep(5); return {}; } },
    }), options)));
    expect(events).toHaveLength(2);
    expect(new Set(events.map(event => event.input.payload.run_id)).size).toBe(2);
    expect(events.map(event => event.input.payload.ran.ref).sort()).toEqual(["flow-1", "flow-2"]);
  });

  test("a deferred pipeline emits after its inherited outer run finishes", async () => {
    let release!: () => void;
    let deferred!: Promise<unknown>;
    await runFlow(flow({ source: { type: "custom", fn: async () => {
      const gate = new Promise<void>(resolve => { release = resolve; });
      deferred = gate.then(() => runPipeline({ name: "deferred-pipeline", actions: [] }, {}, options));
      return {};
    } } }), options);
    release();
    await deferred;
    expect(events.map(event => event.input.payload.ran.ref)).toEqual(["F_LEDGER", "deferred-pipeline"]);
  });

  test("a schedule created in an outer run emits on later independent ticks", async () => {
    let schedule: { stop(): void } | undefined;
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const ticks = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    try {
      await runFlow(flow({ source: { type: "custom", fn: async () => {
        let count = 0;
        schedule = scheduleFlow(flow({ name: "scheduled-child", schedule: { intervalSeconds: 0.03 } }), {
          ...options,
          onRun: () => { if (++count === 3) { schedule!.stop(); finish(); } },
          onError: fail,
        });
        return {};
      } } }), options);
      await ticks;
      // The immediate child is nested; the next two ticks are top-level runs.
      expect(events.map(event => event.input.payload.ran.ref)).toEqual(["F_LEDGER", "scheduled-child", "scheduled-child"]);
    } finally { schedule?.stop(); }
  });

  test("scheduled flow emits once per run on two ticks", async () => {
    let schedule: { stop(): void } | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let count = 0;
        schedule = scheduleFlow(flow({ schedule: { intervalSeconds: 0.03 } }), {
          ...options,
          onRun: () => { if (++count === 2) { schedule!.stop(); resolve(); } },
          onError: reject,
        });
      });
      expect(events).toHaveLength(2);
      expect(payload().run_id).not.toBe(payload(1).run_id);
    } finally { schedule?.stop(); }
  });

  for (const correlation of ["fire-42", "550e8400-e29b-41d4-a716-446655440000", "", undefined]) {
    test(`correlation ID ${JSON.stringify(correlation)}`, async () => {
      if (correlation !== undefined) process.env.MF_CORRELATION_ID = correlation;
      await runFlow(flow(), options);
      if (correlation) expect(payload().correlation_id).toBe(correlation);
      else expect(payload().correlation_id).toMatch(/^[\da-f-]{36}$/i);
      expect(configs[0]!.correlationId).toBe(correlation || undefined);
    });
  }

  for (const [goal, node, expected] of [
    ["G1", undefined, { goal: "G1" }],
    ["G1", "repo#84", { goal: "G1", node: "repo#84" }],
    [undefined, "repo#84", { node: "repo#84" }],
    [undefined, undefined, undefined],
    ["", "", undefined],
  ] as const) {
    test(`serves IDs ${goal}/${node}`, async () => {
      if (goal !== undefined) process.env.MF_SERVES_GOAL = goal;
      if (node !== undefined) process.env.MF_SERVES_NODE = node;
      await runPipeline({ name: "P", actions: [] }, {}, options);
      if (expected) expect(payload().serves).toEqual(expected);
      else expect(payload()).not.toHaveProperty("serves");
    });
  }

  test("env and publisher are captured before the run body", async () => {
    process.env.PULSE_STACK = "personal";
    process.env.PULSE_NATS_URL = "nats://example:4222";
    process.env.PULSE_NATS_CREDS = "/example/creds";
    process.env.XDG_STATE_HOME = "/example/state";
    process.env.MF_CORRELATION_ID = "fire-before";
    process.env.MF_SERVES_GOAL = "G1";
    let restore: (() => void) | undefined;
    try {
      await runFlow(flow({ source: { type: "custom", fn: async () => {
        for (const key of envKeys) process.env[key] = "changed";
        restore = setRunLedgerPublisher(async () => { throw new Error("wrong factory"); });
        return {};
      } } }), options);
      expect(configs[0]).toEqual({
        principal: "jc", stack: "personal", servers: "nats://example:4222",
        credentials: "/example/creds", path: "/example/state/pulse/outbox.jsonl",
        correlationId: "fire-before", serves: { goal: "G1" },
      });
      expect(events[0]!.subject).toBe("local.jc.personal.execution.run.finished");
      expect(payload().correlation_id).toBe("fire-before");
      expect(stderr).not.toHaveBeenCalled();
    } finally { restore?.(); }
  });

  for (const principal of [undefined, ""]) {
    test(`disabled emission (${JSON.stringify(principal)}) builds nothing and calls no publisher`, async () => {
      if (principal === undefined) delete process.env.PULSE_PRINCIPAL;
      else process.env.PULSE_PRINCIPAL = principal;
      // Empty ref would make the builder throw if it were invoked.
      expect((await runFlow(flow({ name: "" }), options)).success).toBe(true);
      expect((await runPipeline({ name: "", actions: [] }, {}, options)).success).toBe(true);
      const runner = new PulseRunner();
      runner.register("a", async () => 1);
      await runner.run({ id: "tree", nodes: [{ id: "a", name: "A" }] });
      expect(events).toHaveLength(0);
      expect(configs).toHaveLength(0);
      expect(stderr).not.toHaveBeenCalled();
    });
  }

  test("disabled outer run remains nested when its body enables emission", async () => {
    delete process.env.PULSE_PRINCIPAL;
    await runFlow(flow({ source: { type: "custom", fn: async () => {
      process.env.PULSE_PRINCIPAL = "jc";
      await runPipeline({ name: "nested", actions: [] }, {}, options);
      return {};
    } } }), options);
    expect(events).toHaveLength(0);
    expect(configs).toHaveLength(0);
  });

  test("builder failure is fail-open without opening a publisher", async () => {
    expect((await runFlow(flow({ name: "" }), options)).success).toBe(true);
    expect(configs).toHaveLength(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]![0]).toContain("payload.ran.ref");
  });

  test("real NATS credential failure is fail-open before any spool is touched", async () => {
    restorePublisher();
    const directory = await mkdtemp(join(tmpdir(), "pulse-ledger-disabled-"));
    process.env.XDG_STATE_HOME = directory;
    process.env.PULSE_NATS_CREDS = join(directory, "missing.creds");
    try {
      expect((await runFlow(flow(), options)).success).toBe(true);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain("Failed to read NATS credentials");
      expect(await Bun.file(join(directory, "pulse", "outbox.jsonl")).exists()).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("disabled production wiring neither builds nor touches its spool", async () => {
    restorePublisher();
    const directory = await mkdtemp(join(tmpdir(), "pulse-ledger-disabled-"));
    delete process.env.PULSE_PRINCIPAL;
    process.env.XDG_STATE_HOME = directory;
    process.env.PULSE_NATS_CREDS = join(directory, "missing.creds");
    try {
      expect((await runFlow(flow({ name: "" }), options)).success).toBe(true);
      expect(stderr).not.toHaveBeenCalled();
      expect(await Bun.file(join(directory, "pulse", "outbox.jsonl")).exists()).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("stalled real NATS handshake releases its socket after the deadline", async () => {
    restorePublisher();
    let connections = 0;
    let opened = 0;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() { connections++; opened++; },
        close() { connections--; },
        data() {},
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "pulse-ledger-handshake-"));
    process.env.PULSE_NATS_URL = `nats://127.0.0.1:${server.port}`;
    process.env.XDG_STATE_HOME = directory;
    try {
      const start = performance.now();
      expect((await runFlow(flow(), options)).success).toBe(true);
      expect(performance.now() - start).toBeLessThan(2800);
      await Bun.sleep(50);
      expect(opened).toBe(1);
      expect(connections).toBe(0);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain("timed out");
      expect(await Bun.file(join(directory, "pulse", "outbox.jsonl")).exists()).toBe(false);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("six overlapping production runs publish without queue starvation or replay duplicates", async () => {
    restorePublisher();
    const received: MyelinEnvelope[] = [];
    let connections = 0;
    let maxConnections = 0;
    let ackMode: "delay" | "stall" | "immediate" = "delay";
    const server = Bun.listen<{ buffer: Buffer; subscriptions: Map<string, string> }>({
      hostname: "127.0.0.1", port: 0,
      socket: {
        open(socket) {
          connections++;
          maxConnections = Math.max(maxConnections, connections);
          socket.data = { buffer: Buffer.alloc(0), subscriptions: new Map() };
          socket.write(`INFO ${JSON.stringify({ server_id: "fixture", version: "2.10.0", proto: 1, headers: true, max_payload: 1048576, jetstream: true })}\r\n`);
        },
        close() { connections--; },
        data(socket, data) {
          const state = socket.data;
          state.buffer = Buffer.concat([state.buffer, Buffer.from(data)]);
          while (true) {
            const end = state.buffer.indexOf("\r\n");
            if (end < 0) return;
            const fields = state.buffer.subarray(0, end).toString().split(" ");
            const command = fields[0];
            if (command === "PUB" || command === "HPUB") {
              const length = Number(fields.at(-1));
              if (state.buffer.length < end + 2 + length + 2) return;
              const headerLength = command === "HPUB" ? Number(fields.at(-2)) : 0;
              const body = state.buffer.subarray(end + 2 + headerLength, end + 2 + length).toString();
              state.buffer = state.buffer.subarray(end + 2 + length + 2);
              const subject = fields[1]!;
              if (subject.startsWith("local.")) received.push(JSON.parse(body));
              const reply = fields[2]!;
              const subscription = [...state.subscriptions.entries()].find(([pattern]) =>
                pattern === reply || (pattern.endsWith(".*") && reply.startsWith(pattern.slice(0, -1))));
              if (subscription) {
                const response = JSON.stringify(subject === "$JS.API.INFO"
                  ? { type: "io.nats.jetstream.api.v1.account_info_response", memory: 0, storage: 0, streams: 1, consumers: 0, limits: {} }
                  : { stream: "RUNS", seq: received.length });
                const ack = `MSG ${reply} ${subscription[1]} ${Buffer.byteLength(response)}\r\n${response}\r\n`;
                // Each run fits its deadline; serializing six runs cannot.
                if (subject.startsWith("local.") && ackMode === "stall") continue;
                if (subject.startsWith("local.") && ackMode === "delay") setTimeout(() => socket.write(ack), 650);
                else socket.write(ack);
              }
            } else {
              state.buffer = state.buffer.subarray(end + 2);
              if (command === "PING") socket.write("PONG\r\n");
              if (command === "SUB") state.subscriptions.set(fields[1]!, fields.at(-1)!);
              if (command === "UNSUB") state.subscriptions.delete(fields[1]!);
            }
          }
        },
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "pulse-ledger-nats-"));
    process.env.PULSE_NATS_URL = `nats://127.0.0.1:${server.port}`;
    process.env.XDG_STATE_HOME = directory;
    try {
      const names = Array.from({ length: 6 }, (_, index) => `P_WORKER_${index}`);
      const start = performance.now();
      const results = await Promise.all(names.map(name =>
        runPipeline({ name, actions: [] }, {}, options)));
      expect(performance.now() - start).toBeLessThan(2800);
      expect(results.every(result => result.success)).toBe(true);
      expect(received).toHaveLength(names.length);
      expect(received.map(envelope => envelope.payload.ran)).toEqual(expect.arrayContaining(
        names.map(ref => ({ kind: "flow", ref })),
      ));
      expect(new Set(received.map(envelope => envelope.payload.run_id)).size).toBe(names.length);
      for (const envelope of received) expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
      const rows = await readSpool(join(directory, "pulse", "outbox.jsonl"));
      expect(rows.filter(row => row.op === "put").map(row => row.id).sort()).toEqual(received.map(envelope => envelope.id).sort());
      expect(rows.filter(row => row.op === "ack").map(row => row.id).sort()).toEqual(received.map(envelope => envelope.id).sort());
      expect(connections).toBe(0);
      expect(maxConnections).toBe(names.length);
      // Once all leases close, the next outbox drains the acknowledged spool.
      await runPipeline({ name: "P_LATER", actions: [] }, {}, options);
      expect(received).toHaveLength(names.length + 1);
      const laterRows = await readSpool(join(directory, "pulse", "outbox.jsonl"));
      expect(laterRows.map(row => row.op)).toEqual(["put", "ack"]);
      expect(laterRows[0].id).toBe(received.at(-1)!.id);
      expect(connections).toBe(0);
      expect(stderr).not.toHaveBeenCalled();

      ackMode = "stall";
      const failedStart = performance.now();
      const stalled = await Promise.all(["P_STALLED_1", "P_STALLED_2"].map(name =>
        runPipeline({ name, actions: [] }, {}, options)));
      expect(stalled.every(result => result.success)).toBe(true);
      expect(performance.now() - failedStart).toBeLessThan(2800);
      await Bun.sleep(50); // Allow worker termination and lease release to finish.
      expect(connections).toBe(0);
      expect(stderr).toHaveBeenCalledTimes(2);
      for (const call of stderr.mock.calls) expect(call[0]).toContain("timed out");
      const retained = await readSpool(join(directory, "pulse", "outbox.jsonl"));
      expect(retained.map(row => row.op)).toEqual(["put", "put"]);
      const retainedIds = retained.map(row => row.id).sort();

      ackMode = "immediate";
      stderr.mockClear();
      const beforeReplay = received.length;
      await runPipeline({ name: "P_REPLAY", actions: [] }, {}, options);
      expect(received.slice(beforeReplay, -1).map(envelope => envelope.id).sort()).toEqual(retainedIds);
      expect(received.at(-1)!.payload.ran).toEqual({ kind: "flow", ref: "P_REPLAY" });
      expect(connections).toBe(0);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const failure of ["connect", "outbox", "publish", "close"] as const) {
    test(`${failure} failure preserves all returned outcomes with one stderr line per run`, async () => {
      const restore = setRunLedgerPublisher(async (_config, log) => {
        if (failure === "connect") throw new Error("connect failed");
        return {
          drained: Promise.resolve(),
          publish: async event => {
            events.push(event);
            if (failure === "outbox") { log("outbox failed\nsecond line"); log("outbox failed again"); }
            if (failure === "publish") throw new Error("publish failed");
          },
          close: async () => { if (failure === "close") throw new Error("close failed"); },
        };
      });
      try {
        expect((await runFlow(flow(), options)).success).toBe(true);
        expect((await runPipeline({ name: "P", actions: ["A_MISSING_LEDGER_TEST"] }, {}, options)).success).toBe(false);
        const runner = new PulseRunner();
        runner.register("a", async () => 1);
        expect((await runner.run({ id: "tree", nodes: [{ id: "a", name: "A" }] })).status).toBe("completed");
        expect(stderr).toHaveBeenCalledTimes(3);
        for (const call of stderr.mock.calls) {
          expect(call[0]).toContain(`${failure} failed`);
          expect(call[0]).not.toContain("\n");
        }
      } finally { restore(); }
    });
  }

  for (const stage of ["connect", "drain", "publish", "close"] as const) {
    test(`2000 ms ceiling includes ${stage}`, async () => {
      let aborted = false;
      const restore = setRunLedgerPublisher(async (_config, _log, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        if (stage === "connect") { await never(); }
        return {
          drained: stage === "drain" ? never() : Promise.resolve(),
          publish: stage === "publish" ? never : async event => {
            events.push(event);
            if (stage === "close") _log("outbox failed before close stalled");
          },
          close: stage === "close" ? never : async () => { closes++; },
        };
      });
      try {
        const start = performance.now();
        expect((await runFlow(flow(), options)).success).toBe(true);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(1950);
        expect(elapsed).toBeLessThan(2800);
        expect(aborted).toBe(true);
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(stderr.mock.calls[0]![0]).toContain("emit timed out after 2000 ms");
      } finally { restore(); }
    });
  }

  test("timeout preserves the exact original thrown error", async () => {
    const restore = setRunLedgerPublisher(async () => { await never(); return {} as RunLedgerPublisher; });
    const error = new Error("original");
    const runner = new PulseRunner();
    runner.register("a", async () => 1);
    runner.on("event", () => { throw error; });
    try {
      await expect(runner.run({ id: "throws", nodes: [{ id: "a", name: "A" }] })).rejects.toBe(error);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain("timed out");
    } finally { restore(); }
  });

  test("late connect is closed without draining or publishing after timeout", async () => {
    let finishConnect!: (publisher: RunLedgerPublisher) => void;
    const restore = setRunLedgerPublisher(async () => new Promise(resolve => { finishConnect = resolve; }));
    try {
      await runPipeline({ name: "P", actions: [] }, {}, options);
      finishConnect({
        drained: Promise.resolve(),
        publish: async event => { events.push(event); },
        close: async () => { closes++; },
      });
      await Bun.sleep(5);
      expect(events).toHaveLength(0);
      expect(closes).toBe(1);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  test("real envelope/outbox wiring replays before publishing and closes the transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pulse-ledger-"));
    const path = join(directory, "outbox.jsonl");
    const inner = new InMemoryTransport();
    const received: MyelinEnvelope[] = [];
    await inner.subscribe("local.jc.default.execution.run.finished", async envelope => { received.push(envelope); });
    const { subject: oldSubject, envelope: oldEnvelope } = await seedOldRun(path);
    const restore = setRunLedgerPublisher(async (config, log) => createOutboxRunLedgerPublisher(inner, { ...config, path }, log));
    try {
      const result = await runFlow(flow(), options);
      expect(result.success).toBe(true);
      expect(received).toHaveLength(2);
      expect(received[0]!.id).toBe(oldEnvelope.id);
      expect(received[1]!.payload.ran).toEqual({ kind: "flow", ref: "F_LEDGER" });
      for (const envelope of received) expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
      const rows = await readSpool(path);
      expect(rows.map(row => row.op)).toEqual(["put", "ack"]);
      expect(rows[0].envelope.id).toBe(received[1]!.id);
      expect(rows[1].id).toBe(received[1]!.id);
      await expect(inner.publish(oldSubject, oldEnvelope)).rejects.toThrow("Transport closed");
      expect(stderr).not.toHaveBeenCalled();
      // A real outbox failure is logged and retained for replay, never rejected.
      expect((await runFlow(flow(), options)).success).toBe(true);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain("publish failed");
      const pending = await readSpool(path);
      expect(pending.map(row => row.op)).toEqual(["put"]);
    } finally {
      restore();
      await inner.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("startup replay outlives its creator's lease and sends through one still open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pulse-ledger-"));
    const path = join(directory, "outbox.jsonl");
    const { subject: oldSubject, envelope: oldEnvelope } = await seedOldRun(path);
    const creatorInner = new InMemoryTransport();
    const survivorInner = new InMemoryTransport();
    const received: MyelinEnvelope[] = [];
    await survivorInner.subscribe(oldSubject, async envelope => { received.push(envelope); });
    const config: RunLedgerConfig = { principal: "jc", stack: "default", servers: "unused", path };
    const logs: string[] = [];
    const creator = createOutboxRunLedgerPublisher(creatorInner, config, message => { logs.push(message); });
    const survivor = createOutboxRunLedgerPublisher(survivorInner, config, message => { logs.push(message); });
    try {
      await creator.close();
      await survivor.drained;
      expect(received.map(envelope => envelope.id)).toEqual([oldEnvelope.id]);
      expect(logs).toEqual([]);
    } finally {
      await survivor.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
