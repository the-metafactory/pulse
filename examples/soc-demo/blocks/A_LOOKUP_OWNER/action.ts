/**
 * A_LOOKUP_OWNER — offline IP → responsible OU + contact (CMDB/NetDB adapter).
 *
 * The NREN-specific D-class block (design/soc-demo-mm-composer.md §4): resolves
 * an address against an embedded asset-ownership fixture, the demo stand-in for
 * a real CMDB/NetDB. No env, no network, no capabilities — pure and offline. An
 * unknown IP is a documented result ({ known: false, ou: "unknown",
 * contact: null }), never an error: not knowing who owns an address is a normal
 * outcome the downstream flow must handle, not a crash.
 */

import type { ActionContext } from "../../../../src/types/action";
import { OWNER_TABLE } from "./fixtures";

interface OwnerResult {
  ip: string;
  ou: string;
  contact: string | null;
  known: boolean;
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { ip, ...payload } = input;
    if (typeof ip !== "string" || ip.length === 0) {
      throw new Error("A_LOOKUP_OWNER: ip must be a non-empty string");
    }

    const hit = OWNER_TABLE[ip.trim()];
    const owner: OwnerResult = hit
      ? { ip, ou: hit.ou, contact: hit.contact, known: true }
      : { ip, ou: "unknown", contact: null, known: false };

    return { ...payload, owner };
  },
};
