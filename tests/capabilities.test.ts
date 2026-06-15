import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalCapabilities } from "../src/lib/capabilities";

/** Point PULSE_CLAUDE_BIN at a fake `claude` emitting the given JSON wrapper. */
function withFakeClaude(body: string): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  const prev = process.env.PULSE_CLAUDE_BIN;
  process.env.PULSE_CLAUDE_BIN = bin;
  return {
    dir,
    restore: () => {
      if (prev === undefined) delete process.env.PULSE_CLAUDE_BIN;
      else process.env.PULSE_CLAUDE_BIN = prev;
    },
  };
}

describe("createLocalCapabilities", () => {
  test("returns empty capabilities when none requested", async () => {
    const caps = await createLocalCapabilities([]);
    expect(caps.llm).toBeUndefined();
    expect(caps.fetch).toBeUndefined();
    expect(caps.shell).toBeUndefined();
  });

  test("provides fetch capability", async () => {
    const caps = await createLocalCapabilities(["fetch"]);
    expect(caps.fetch).toBeDefined();
    expect(typeof caps.fetch).toBe("function");
  });

  test("provides shell capability that executes commands", async () => {
    const caps = await createLocalCapabilities(["shell"]);
    expect(caps.shell).toBeDefined();
    const result = await caps.shell!("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.code).toBe(0);
  });

  test("shell capability returns error code on failure", async () => {
    const caps = await createLocalCapabilities(["shell"]);
    const result = await caps.shell!("exit 42");
    expect(result.code).toBe(42);
  });

  test("provides readFile capability", async () => {
    const caps = await createLocalCapabilities(["readFile"]);
    expect(caps.readFile).toBeDefined();
    // Read our own package.json as proof it works
    const content = await caps.readFile!(`${import.meta.dir}/../package.json`);
    expect(content).toContain('"pulse"');
  });

  test("provides writeFile capability", async () => {
    const caps = await createLocalCapabilities(["writeFile"]);
    expect(caps.writeFile).toBeDefined();
  });

  test("provides kv capability with get/set/delete", async () => {
    const caps = await createLocalCapabilities(["kv"]);
    expect(caps.kv).toBeDefined();

    await caps.kv!.set("test-key", "test-value");
    const value = await caps.kv!.get("test-key");
    expect(value).toBe("test-value");

    await caps.kv!.delete("test-key");
    const deleted = await caps.kv!.get("test-key");
    expect(deleted).toBeNull();
  });

  test("kv respects TTL expiration", async () => {
    const caps = await createLocalCapabilities(["kv"]);
    // Set with very short TTL
    await caps.kv!.set("expires", "soon", 0.001); // 1ms
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 20));
    const value = await caps.kv!.get("expires");
    expect(value).toBeNull();
  });

  test("llm via claude -p strips ANTHROPIC_API_KEY (uses CC subscription/OAuth)", async () => {
    // Fake claude reports whether the key reached its environment.
    const fake = withFakeClaude(
      'if [ -n "$ANTHROPIC_API_KEY" ]; then R=KEY_PRESENT; else R=KEY_ABSENT; fi\n' +
        'printf \'{"type":"result","is_error":false,"result":"%s"}\' "$R"',
    );
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    try {
      const caps = await createLocalCapabilities(["llm"]);
      const r = await caps.llm!("hi");
      expect(r.text).toBe("KEY_ABSENT"); // stripped from the claude -p subprocess
    } finally {
      fake.restore();
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  test("llm treats an is_error claude result as a miss (never returns the error string)", async () => {
    const sentinel = "Invalid API key · should never be surfaced as output";
    const fake = withFakeClaude(
      `printf '{"type":"result","is_error":true,"result":"${sentinel}"}'`,
    );
    // Isolate from real backends so a stage-1 miss fails FAST with no network:
    // no key, and a cwd/HOME where none of stage 3's .env candidates resolve.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevHome = process.env.HOME;
    const prevCwd = process.cwd();
    delete process.env.ANTHROPIC_API_KEY;
    process.env.HOME = fake.dir;
    process.chdir(fake.dir);
    try {
      const caps = await createLocalCapabilities(["llm"]);
      let text: string | undefined;
      try {
        text = (await caps.llm!("hi")).text;
      } catch (err) {
        // Stage-1 miss + no other backend → clean "no backend" error, NOT the
        // error string surfaced as output.
        expect(String(err)).toContain("LLM capability requires");
      }
      expect(text).toBeUndefined();
    } finally {
      process.chdir(prevCwd);
      fake.restore();
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
      process.env.HOME = prevHome;
    }
  });

  test("only creates requested capabilities", async () => {
    const caps = await createLocalCapabilities(["fetch", "kv"]);
    expect(caps.fetch).toBeDefined();
    expect(caps.kv).toBeDefined();
    expect(caps.shell).toBeUndefined();
    expect(caps.llm).toBeUndefined();
    expect(caps.readFile).toBeUndefined();
  });
});
