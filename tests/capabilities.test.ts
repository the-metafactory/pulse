import { describe, expect, test } from "bun:test";
import { createLocalCapabilities } from "../src/lib/capabilities";

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

  test("only creates requested capabilities", async () => {
    const caps = await createLocalCapabilities(["fetch", "kv"]);
    expect(caps.fetch).toBeDefined();
    expect(caps.kv).toBeDefined();
    expect(caps.shell).toBeUndefined();
    expect(caps.llm).toBeUndefined();
    expect(caps.readFile).toBeUndefined();
  });
});
