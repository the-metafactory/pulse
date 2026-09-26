/**
 * NatsAgentTransport.connect — creds resolution. No NATS server: the `nats`
 * module is replaced through the connect seam, so the suite stays offline.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NatsAgentTransport } from "../src/lib/agent-provider";

const fakeConn = {
  publish: () => {},
  subscribe: () => ({ unsubscribe: () => {} }),
  drain: async () => {},
};

/** A fake `nats` module that records the connect options and the creds bytes. */
function fakeNats() {
  const calls: { connect: Record<string, unknown>[]; creds: string[] } = { connect: [], creds: [] };
  const mod = {
    connect: async (o: Record<string, unknown>) => {
      calls.connect.push(o);
      return fakeConn;
    },
    credsAuthenticator: (creds: Uint8Array) => {
      calls.creds.push(new TextDecoder().decode(creds));
      return "authenticator";
    },
  };
  return { calls, load: async () => mod };
}

let dir: string;
let credsFile: string;
const savedEnv = process.env.PULSE_NATS_CREDS;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-nats-"));
  credsFile = join(dir, "pulse.creds");
  writeFileSync(credsFile, "-----BEGIN NATS USER JWT-----\nfake\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  if (savedEnv === undefined) delete process.env.PULSE_NATS_CREDS;
  else process.env.PULSE_NATS_CREDS = savedEnv;
});

describe("NatsAgentTransport.connect", () => {
  test("no creds anywhere connects anonymously", async () => {
    delete process.env.PULSE_NATS_CREDS;
    const nats = fakeNats();
    await NatsAgentTransport.connect({ servers: "nats://127.0.0.1:4222" }, nats.load);
    expect(nats.calls.connect).toEqual([{ servers: "nats://127.0.0.1:4222" }]);
    expect(nats.calls.creds).toEqual([]);
  });

  test("defaults the server to localhost:4222", async () => {
    delete process.env.PULSE_NATS_CREDS;
    const nats = fakeNats();
    await NatsAgentTransport.connect({}, nats.load);
    expect(nats.calls.connect[0].servers).toBe("localhost:4222");
  });

  test("credentials option passes a creds authenticator", async () => {
    delete process.env.PULSE_NATS_CREDS;
    const nats = fakeNats();
    await NatsAgentTransport.connect({ credentials: credsFile, name: "pulse-soc" }, nats.load);
    expect(nats.calls.creds).toEqual(["-----BEGIN NATS USER JWT-----\nfake\n"]);
    expect(nats.calls.connect[0]).toEqual({
      servers: "localhost:4222",
      name: "pulse-soc",
      authenticator: "authenticator",
    });
  });

  test("PULSE_NATS_CREDS is the fallback", async () => {
    process.env.PULSE_NATS_CREDS = credsFile;
    const nats = fakeNats();
    await NatsAgentTransport.connect({}, nats.load);
    expect(nats.calls.connect[0].authenticator).toBe("authenticator");
  });

  test("the option wins over PULSE_NATS_CREDS", async () => {
    process.env.PULSE_NATS_CREDS = join(dir, "missing.creds");
    const nats = fakeNats();
    await NatsAgentTransport.connect({ credentials: credsFile }, nats.load);
    expect(nats.calls.creds).toHaveLength(1);
  });

  test("an unreadable creds path throws and never connects", async () => {
    delete process.env.PULSE_NATS_CREDS;
    const nats = fakeNats();
    const missing = join(dir, "missing.creds");
    await expect(NatsAgentTransport.connect({ credentials: missing }, nats.load)).rejects.toThrow(
      `NATS credentials file unreadable: ${missing}`,
    );
    expect(nats.calls.connect).toEqual([]);
  });

  test("an unreadable PULSE_NATS_CREDS throws too", async () => {
    process.env.PULSE_NATS_CREDS = join(dir, "missing.creds");
    const nats = fakeNats();
    await expect(NatsAgentTransport.connect({}, nats.load)).rejects.toThrow("PULSE_NATS_CREDS");
    expect(nats.calls.connect).toEqual([]);
  });

  test("a missing nats package surfaces the install hint", async () => {
    delete process.env.PULSE_NATS_CREDS;
    const load = async () => {
      throw new Error("Cannot find package 'nats'");
    };
    await expect(NatsAgentTransport.connect({}, load)).rejects.toThrow("bun add nats");
  });
});
