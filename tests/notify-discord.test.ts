/**
 * A_NOTIFY_DISCORD — the pipeline-facing Discord delivery action that shells
 * out to the cortex `discord` CLI. Tests drive the action's execute() with a
 * stub `shell` capability so no real CLI, token, or network is touched: we
 * assert the command it builds (channel/server/files/message, shell-quoted),
 * the skip-when-unconfigured behavior, and that a non-zero exit fails loudly.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import action from "../examples/notify-discord/A_NOTIFY_DISCORD/action";
import type { ActionContext, ShellResult } from "../src/types/action";

// The action falls back to env config; clear it so the suite is deterministic
// regardless of the developer/CI shell (sage pulse#51).
beforeEach(() => {
  delete process.env.DISCORD_CHANNEL;
  delete process.env.DISCORD_SERVER;
  delete process.env.DISCORD_FILES_ROOT;
});

function ctxWithShell(impl: (cmd: string) => Promise<ShellResult>): ActionContext {
  return { capabilities: { shell: impl } } as unknown as ActionContext;
}

const ok: ShellResult = { stdout: "Posted to #ops (+1 file)", stderr: "", code: 0 };

describe("A_NOTIFY_DISCORD", () => {
  test("builds the discord command with channel, files, and a quoted message", async () => {
    let seen = "";
    const ctx = ctxWithShell(async (cmd) => {
      seen = cmd;
      return ok;
    });
    const out = await action.execute(
      { discord_channel: "ops", discord_message: "build done", discord_files: ["/tmp/a.md", "/tmp/b.json"], keep: 1 },
      ctx,
    );
    expect(seen).toBe("discord post --channel 'ops' --file '/tmp/a.md' --file '/tmp/b.json' 'build done'");
    const rec = out as Record<string, unknown>;
    expect((rec.discord as Record<string, unknown>).skipped).toBe(false);
    expect((rec.discord as Record<string, unknown>).files).toBe(2);
    expect(rec.keep).toBe(1); // passthrough preserved
  });

  test("passes --server when set; message-only post needs no --file", async () => {
    let seen = "";
    const ctx = ctxWithShell(async (cmd) => ((seen = cmd), ok));
    await action.execute({ discord_channel: "general", discord_server: "grove", discord_message: "hi" }, ctx);
    expect(seen).toBe("discord post --channel 'general' --server 'grove' 'hi'");
  });

  test("shell-quotes a message containing quotes and spaces (no injection)", async () => {
    let seen = "";
    const ctx = ctxWithShell(async (cmd) => ((seen = cmd), ok));
    await action.execute({ discord_channel: "ops", discord_message: "it's $(rm -rf /) — careful" }, ctx);
    // The whole message is a single literal single-quoted arg; the embedded
    // quote is escaped, so the shell never sees $() or the bare apostrophe.
    expect(seen).toContain(`'it'\\''s $(rm -rf /) — careful'`);
    expect(seen.startsWith("discord post --channel 'ops' ")).toBe(true);
  });

  test("file-only post (empty message) omits the trailing message arg", async () => {
    let seen = "";
    const ctx = ctxWithShell(async (cmd) => ((seen = cmd), ok));
    await action.execute({ discord_channel: "ops", discord_files: ["/tmp/report.pdf"] }, ctx);
    expect(seen).toBe("discord post --channel 'ops' --file '/tmp/report.pdf'");
  });

  test("skips (no-op passthrough) when no channel is configured", async () => {
    let called = false;
    const ctx = ctxWithShell(async () => ((called = true), ok));
    const out = await action.execute({ discord_message: "nowhere to go" }, ctx);
    expect(called).toBe(false);
    expect((out.discord as Record<string, unknown>).skipped).toBe(true);
  });

  test("skips when there is nothing to post (no message, no files)", async () => {
    let called = false;
    const ctx = ctxWithShell(async () => ((called = true), ok));
    const out = await action.execute({ discord_channel: "ops" }, ctx);
    expect(called).toBe(false);
    expect((out.discord as Record<string, unknown>).reason).toBe("empty");
  });

  test("a non-zero exit fails the pipeline with the CLI's stderr", async () => {
    const ctx = ctxWithShell(async () => ({ stdout: "", stderr: "Bot token required", code: 1 }));
    await expect(
      action.execute({ discord_channel: "ops", discord_message: "x" }, ctx),
    ).rejects.toThrow(/discord CLI exited 1 — Bot token required/);
  });

  test("a malformed attachment list is an error, never a silent drop", async () => {
    const ctx = ctxWithShell(async () => ok);
    await expect(
      action.execute({ discord_channel: "ops", discord_files: ["/tmp/a.md", 42] }, ctx),
    ).rejects.toThrow(/discord_files\[1\] is not a non-empty string/);
    await expect(
      action.execute({ discord_channel: "ops", discord_files: "not-an-array" }, ctx),
    ).rejects.toThrow(/discord_files must be an array/);
  });

  test("confinement root rejects a path that escapes it, accepts one inside", async () => {
    let seen = "";
    const ctx = ctxWithShell(async (cmd) => ((seen = cmd), ok));
    await expect(
      action.execute({ discord_channel: "ops", discord_files_root: "/tmp/out", discord_files: ["../../etc/passwd"] }, ctx),
    ).rejects.toThrow(/escapes the confinement root/);
    // A path inside the root resolves to its absolute form and is sent.
    await action.execute({ discord_channel: "ops", discord_files_root: "/tmp/out", discord_files: ["report.pdf"] }, ctx);
    expect(seen).toBe("discord post --channel 'ops' --file '/tmp/out/report.pdf'");
  });
});
