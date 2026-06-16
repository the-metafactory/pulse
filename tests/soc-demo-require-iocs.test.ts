/**
 * A_REQUIRE_IOCS — deterministic empty-IOC guard.
 *
 * Locks the safety property: zero indicators → loud failure (no triage on an
 * empty payload, so the hallucinated-advisory failure mode cannot recur); any
 * indicator present → clean passthrough.
 */

import { describe, expect, test } from "bun:test";
import { ctxWith } from "./helpers/soc-demo-test-helpers";

const mod = () => import("../examples/soc-demo/blocks/A_REQUIRE_IOCS/action");

describe("A_REQUIRE_IOCS", () => {
  test("zero IOCs (all empty/absent) → throws", async () => {
    const m = await mod();
    expect(m.default.execute({ ips: [], domains: [], urls: [], hashes: [] }, ctxWith())).rejects.toThrow(
      /no indicators of compromise/i,
    );
  });

  test("missing arrays entirely → throws (treated as empty)", async () => {
    const m = await mod();
    expect(m.default.execute({ scenario: "nothing here" }, ctxWith())).rejects.toThrow(/A_REQUIRE_IOCS/);
  });

  test("one IP present → passthrough, payload preserved", async () => {
    const m = await mod();
    const out = (await m.default.execute(
      { ips: ["167.71.70.184"], domains: [], urls: [], hashes: [], case_id: "c1" },
      ctxWith(),
    )) as Record<string, unknown>;
    expect(out.case_id).toBe("c1");
    expect(out.ips).toEqual(["167.71.70.184"]);
  });

  test("only a domain present → passthrough (any IOC type counts)", async () => {
    const m = await mod();
    const out = (await m.default.execute({ domains: ["evil.example"] }, ctxWith())) as Record<string, unknown>;
    expect(out.domains).toEqual(["evil.example"]);
  });
});
