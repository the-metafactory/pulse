/**
 * Enforcement gate tests — the fail-closed invariants are the spec.
 *
 * Ported from Magnús Smárason's enforcement-gate/SPEC.md v1 "fail-closed
 * invariants" section. These prove the whole point: no path to allow that
 * isn't an explicit matching rule; every ambiguous case denies.
 */

import { describe, test, expect } from "bun:test";
import { evaluate } from "../src/lib/enforcement-gate";
import { loadPolicy, guardCapabilities, DENY_ALL, PolicyDenial } from "../src/lib/policy-loader";
import type { Policy } from "../src/types/policy";

const allowReads: Policy = {
  version: 1,
  default: "deny",
  rules: [
    { tool: "Bash", match: { command: "rm\\s+-rf\\s+/" }, decision: "deny", reason: "root delete" },
    { tool: "Bash", match: { command: "\\b(curl|wget)\\b" }, decision: "ask", reason: "egress" },
    { tool: "Read", decision: "allow", reason: "reads ok" },
    { tool: "Write", match: { path: "^/(etc|usr|bin)/" }, decision: "deny", reason: "system path" },
    { tool: "Write", decision: "ask", reason: "other writes ask" },
  ],
};

describe("evaluate — algorithm", () => {
  test("first match wins, ordered", () => {
    // rm -rf / matches the deny rule before any broader rule
    expect(evaluate("Bash", { command: "rm -rf /" }, allowReads).decision).toBe("deny");
  });

  test("match requires all fields present and matching", () => {
    expect(evaluate("Bash", { command: "ls -la" }, allowReads).decision).toBe("deny"); // falls to default
    expect(evaluate("Read", { path: "/home/x" }, allowReads).decision).toBe("allow");
  });

  test("ask is a distinct third outcome", () => {
    expect(evaluate("Bash", { command: "curl https://x" }, allowReads).decision).toBe("ask");
    expect(evaluate("Write", { path: "/home/x" }, allowReads).decision).toBe("ask");
  });

  test("tool '*' matches any tool; absent tool defaults to '*'", () => {
    const p: Policy = { version: 1, default: "deny", rules: [{ decision: "allow" }] };
    expect(evaluate("AnythingAtAll", {}, p).decision).toBe("allow");
  });

  test("reports the matching rule index, -1 for default", () => {
    expect(evaluate("Read", { path: "/x" }, allowReads).rule_index).toBe(2);
    expect(evaluate("Bash", { command: "ls" }, allowReads).rule_index).toBe(-1);
  });
});

describe("evaluate — fail-closed invariants (the whole point)", () => {
  test("no silent allow: omission never allows", () => {
    const p: Policy = { version: 1, rules: [{ tool: "Read", decision: "allow" }] }; // no default
    expect(evaluate("Bash", { command: "ls" }, p).decision).toBe("deny");
  });

  test("default defaults to deny when absent", () => {
    const p: Policy = { version: 1, rules: [] };
    expect(evaluate("Bash", { command: "ls" }, p).decision).toBe("deny");
  });

  test("absent/null/malformed policy denies", () => {
    expect(evaluate("Bash", { command: "ls" }, null).decision).toBe("deny");
    expect(evaluate("Bash", { command: "ls" }, undefined).decision).toBe("deny");
    expect(evaluate("Bash", { command: "ls" }, { version: 1, rules: "nope" } as unknown as Policy).decision).toBe("deny");
  });

  test("empty / non-string tool name denies", () => {
    expect(evaluate("", { command: "ls" }, allowReads).decision).toBe("deny");
    expect(evaluate(42 as unknown as string, { command: "ls" }, allowReads).decision).toBe("deny");
  });

  test("invalid decision value coerces to deny", () => {
    const p: Policy = { version: 1, default: "deny", rules: [{ tool: "Bash", decision: "yolo" as never }] };
    expect(evaluate("Bash", { command: "ls" }, p).decision).toBe("deny");
  });

  test("invalid default coerces to deny", () => {
    const p: Policy = { version: 1, default: "maybe" as never, rules: [] };
    expect(evaluate("Bash", { command: "ls" }, p).decision).toBe("deny");
  });

  test("unparseable regex fails closed, does not throw", () => {
    const p: Policy = { version: 1, default: "allow", rules: [{ tool: "Bash", match: { command: "(" } }] };
    const d = evaluate("Bash", { command: "ls" }, p);
    expect(d.decision).toBe("deny");
  });

  test("non-string field values are JSON-serialized for matching, never crash", () => {
    const p: Policy = {
      version: 1,
      default: "deny",
      rules: [{ tool: "Write", match: { content: "secret" }, decision: "deny" }],
    };
    expect(evaluate("Write", { content: { token: "secret" } }, p).decision).toBe("deny");
  });
});

describe("loadPolicy — fail-closed loading", () => {
  test("missing file → DENY_ALL", async () => {
    const r = await loadPolicy("/nonexistent/policy.json");
    expect(r.ok).toBe(false);
    expect(r.policy).toEqual(DENY_ALL);
  });

  test("malformed JSON → DENY_ALL", async () => {
    const path = `/tmp/pulse-bad-policy-${process.pid}.json`;
    await Bun.write(path, "{ not json");
    const r = await loadPolicy(path);
    expect(r.ok).toBe(false);
    expect(r.policy.default ?? "deny").toBe("deny");
  });

  test("valid policy loads", async () => {
    const path = `/tmp/pulse-ok-policy-${process.pid}.json`;
    await Bun.write(path, JSON.stringify(allowReads));
    const r = await loadPolicy(path);
    expect(r.ok).toBe(true);
    expect(r.policy.rules?.length).toBe(5);
  });
});

describe("guardCapabilities — the gate bites", () => {
  test("denied shell call throws PolicyDenial; allowed runs", async () => {
    let ran = false;
    const caps = { shell: async (_cmd: string | string[]) => { ran = true; return { stdout: "", stderr: "", code: 0 }; } };
    const policy: Policy = {
      version: 1,
      default: "deny",
      rules: [{ tool: "Bash", match: { command: "^echo " }, decision: "allow" }],
    };
    const guarded = guardCapabilities(caps, { policy });

    await expect(guarded.shell!("rm -rf /")).rejects.toBeInstanceOf(PolicyDenial);
    expect(ran).toBe(false);

    await guarded.shell!("echo hi");
    expect(ran).toBe(true);
  });

  test("absent capabilities stay absent (no capability granted)", () => {
    const guarded = guardCapabilities({}, { policy: DENY_ALL });
    expect(guarded.shell).toBeUndefined();
    expect(guarded.fetch).toBeUndefined();
  });

  test("audit-only mode logs but lets the call through", async () => {
    const decisions: string[] = [];
    let ran = false;
    const caps = { writeFile: (async (_p: string, _c: string) => { ran = true; }) };
    const guarded = guardCapabilities(caps, {
      policy: DENY_ALL,
      auditOnly: true,
      onDecision: (e) => decisions.push(`${e.tool}:${e.decision.decision}`),
    });
    await guarded.writeFile!("/etc/passwd", "x");
    expect(ran).toBe(true);
    expect(decisions).toEqual(["Write:deny"]);
  });

  test("onDecision fires on every non-allow", async () => {
    const events: string[] = [];
    const caps = { fetch: (async () => new Response("ok")) as unknown as typeof fetch };
    const guarded = guardCapabilities(caps, {
      policy: { version: 1, default: "deny", rules: [] },
      auditOnly: true,
      onDecision: (e) => events.push(e.tool),
    });
    await guarded.fetch!("https://example.com");
    expect(events).toEqual(["Fetch"]);
  });

  test("readFile is guarded by path", async () => {
    let ran = false;
    const caps = { readFile: async (_p: string) => { ran = true; return "data"; } };
    const policy: Policy = {
      version: 1,
      default: "deny",
      rules: [{ tool: "Read", match: { path: "^/safe/" }, decision: "allow" }],
    };
    const guarded = guardCapabilities(caps, { policy });
    await expect(guarded.readFile!("/etc/passwd")).rejects.toBeInstanceOf(PolicyDenial);
    expect(ran).toBe(false);
    expect(await guarded.readFile!("/safe/x")).toBe("data");
    expect(ran).toBe(true);
  });

  test("audit hook distinguishes ask-became-deny from hard deny", async () => {
    const seen: string[] = [];
    const caps = { shell: async (_c: string | string[]) => ({ stdout: "", stderr: "", code: 0 }) };
    const policy: Policy = {
      version: 1,
      default: "deny",
      rules: [{ tool: "Bash", match: { command: "^curl " }, decision: "ask" }],
    };
    const guarded = guardCapabilities(caps, {
      policy,
      auditOnly: true,
      onDecision: (e) => seen.push(e.decision.decision),
    });
    await guarded.shell!("curl https://x"); // ask → audit sees "ask"
    await guarded.shell!("rm -rf /");        // default → audit sees "deny"
    expect(seen).toEqual(["ask", "deny"]);
  });
});
