/**
 * W-5 slice 3 — the two stub-safe blocks that close the credential-leak
 * catalog gap the real-LLM composer flagged: A_RESOLVE_ACCOUNT_OWNER
 * (email→owner, the IAM/directory adapter) and A_REQUEST_RESET (queue an IAM
 * force-reset, behind a gate). Offline + fail-soft, mirroring A_LOOKUP_OWNER.
 */

import { describe, expect, test } from "bun:test";
import { ctxWith } from "./helpers/soc-demo-test-helpers";

describe("A_RESOLVE_ACCOUNT_OWNER", () => {
  test("known email: resolves account/ou/contact, passthrough preserved", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_RESOLVE_ACCOUNT_OWNER/action");
    const r = (await mod.default.execute({ email: "test@example.org", case_id: "c1" }, ctxWith())) as Record<string, any>;
    expect(r.account_owner.known).toBe(true);
    expect(r.account_owner.account).toBe("u-1041");
    expect(r.account_owner.ou).toContain("Member-University-A");
    expect(r.case_id).toBe("c1"); // passthrough
  });

  test("unknown email: known false, account null, never throws", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_RESOLVE_ACCOUNT_OWNER/action");
    const r = (await mod.default.execute({ email: "nobody@nowhere.example" }, ctxWith())) as Record<string, any>;
    expect(r.account_owner.known).toBe(false);
    expect(r.account_owner.account).toBeNull();
  });

  test("missing email throws (required scalar)", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_RESOLVE_ACCOUNT_OWNER/action");
    await expect(mod.default.execute({}, ctxWith())).rejects.toThrow(/email/);
  });
});

describe("A_REQUEST_RESET", () => {
  test("resolved owner: queues a reset with a ref", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_REQUEST_RESET/action");
    const r = (await mod.default.execute(
      { account_owner: { account: "u-1041", known: true }, case_id: "c2" },
      ctxWith(),
    )) as Record<string, any>;
    expect(r.reset_request.status).toBe("queued");
    expect(r.reset_request.queued_ref).toBe("IAM-RESET-u-1041");
    expect(r.case_id).toBe("c2");
  });

  test("unresolved owner: skipped, never throws", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_REQUEST_RESET/action");
    const r = (await mod.default.execute(
      { account_owner: { account: null, known: false } },
      ctxWith(),
    )) as Record<string, any>;
    expect(r.reset_request.status).toBe("skipped");
  });

  test("missing account_owner throws (required object)", async () => {
    const mod = await import("../examples/soc-demo/blocks/A_REQUEST_RESET/action");
    await expect(mod.default.execute({}, ctxWith())).rejects.toThrow(/account_owner/);
  });
});
