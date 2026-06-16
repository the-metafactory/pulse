/**
 * A_LOOKUP_OWNER — IP → responsible org (OU) + abuse contact.
 *
 * Fixture-first, live-fallback (design/soc-demo-mm-composer.md §4):
 *   1. Embedded NREN CMDB/NetDB fixture (SWITCH, ETH, UniBE…) — instant,
 *      offline, deterministic for the known demo IPs + tests.
 *   2. Otherwise, if a `fetch` capability is present, a LIVE keyless RDAP
 *      lookup via rdap.org (the IANA bootstrap redirector → the owning RIR).
 *      Org name from the registrant entity / network name; abuse email from
 *      the entity carrying the "abuse" role (recursively).
 *   3. No capability (offline), non-IPv4, non-OK response, or any error →
 *      `{ known: false, ou: "unknown", contact: null }`. Not knowing who owns
 *      an address is a normal outcome, never a crash.
 *
 * The IP is only ever a PATH segment of the fixed rdap.org host
 * (encodeURIComponent'd) — no SSRF surface, no host guard needed.
 */

import type { ActionContext } from "../../../../src/types/action";
import { OWNER_TABLE } from "./fixtures";

interface OwnerResult {
  ip: string;
  ou: string;
  contact: string | null;
  known: boolean;
  source?: "fixture" | "rdap";
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const LOOKUP_TIMEOUT_MS = 6000;

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, unknown[]];
  entities?: RdapEntity[];
}

/** Pull a jCard field (fn / email) from an RDAP entity's vcardArray. */
function vcardField(entity: RdapEntity | null, field: string): string | null {
  const vc = entity?.vcardArray?.[1];
  if (!Array.isArray(vc)) return null;
  for (const row of vc) {
    if (Array.isArray(row) && row[0] === field && typeof row[3] === "string" && row[3].length > 0) {
      return row[3];
    }
  }
  return null;
}

/** Depth-first search for the first entity carrying `role`. */
function findEntityByRole(entities: RdapEntity[] | undefined, role: string): RdapEntity | null {
  for (const e of entities ?? []) {
    if (Array.isArray(e.roles) && e.roles.includes(role)) return e;
    const nested = findEntityByRole(e.entities, role);
    if (nested) return nested;
  }
  return null;
}

/** First email found anywhere in the entity tree (abuse-role preferred by caller). */
function anyEmail(entities: RdapEntity[] | undefined): string | null {
  for (const e of entities ?? []) {
    const email = vcardField(e, "email");
    if (email) return email;
    const nested = anyEmail(e.entities);
    if (nested) return nested;
  }
  return null;
}

/** Live RDAP lookup via rdap.org; null on any failure (caller → unknown). */
async function liveLookup(ip: string, fetchFn: typeof globalThis.fetch): Promise<OwnerResult | null> {
  try {
    const res = await fetchFn(`https://rdap.org/ip/${encodeURIComponent(ip)}`, {
      headers: { accept: "application/rdap+json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string; entities?: RdapEntity[] };
    const registrant = findEntityByRole(body.entities, "registrant");
    const abuse = findEntityByRole(body.entities, "abuse");
    const ou =
      vcardField(registrant, "fn") ?? (typeof body.name === "string" && body.name.length > 0 ? body.name : null);
    const contact = vcardField(abuse, "email") ?? anyEmail(body.entities);
    if (ou === null && contact === null) return null; // RDAP said nothing useful
    return { ip, ou: ou ?? "unknown", contact, known: true, source: "rdap" };
  } catch (_err) {
    // Timeout / offline / malformed RDAP — a lookup failure is "unknown owner",
    // never a pipeline error.
    return null;
  }
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { ip, ...payload } = input;
    if (typeof ip !== "string" || ip.length === 0) {
      throw new Error("A_LOOKUP_OWNER: ip must be a non-empty string");
    }
    const addr = ip.trim();

    // 1. Fixture fast-path (offline, deterministic, NREN demo IPs).
    const hit = OWNER_TABLE[addr];
    if (hit) {
      return { ...payload, owner: { ip, ou: hit.ou, contact: hit.contact, known: true, source: "fixture" } };
    }

    // 2. Live RDAP fallback — only with a fetch capability and a real IPv4.
    const fetchFn = ctx.capabilities.fetch;
    if (fetchFn && IPV4_RE.test(addr)) {
      const live = await liveLookup(addr, fetchFn);
      if (live) return { ...payload, owner: live };
    }

    // 3. Unknown owner.
    return { ...payload, owner: { ip, ou: "unknown", contact: null, known: false } };
  },
};
