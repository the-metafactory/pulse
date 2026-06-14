/**
 * A_RESOLVE_ACCOUNT_OWNER — offline email → account owner (IAM/directory adapter).
 *
 * D-class block (design/soc-demo-mm-composer.md §4): resolves an email address
 * against an embedded directory fixture — the demo stand-in for a real
 * IAM/LDAP. No env, no network, no capabilities — pure and offline. An unknown
 * address is a documented result ({ known: false, account: null }), never an
 * error: not knowing who owns an address is a normal outcome the downstream
 * flow (a gate, then A_REQUEST_RESET) must handle, not a crash.
 *
 * Closes the catalog gap the real-LLM composer flagged on credential-leak
 * scenarios ("no email→owner resolver"): A_FETCH_HIBP emits `email`; this
 * turns it into `account_owner` for a reset/notification flow.
 */

import type { ActionContext } from "../../../../src/types/action";

interface DirectoryEntry {
  account: string;
  ou: string;
  contact: string;
}

/** Embedded demo directory — the offline IAM/LDAP stand-in. */
const DIRECTORY: Record<string, DirectoryEntry> = {
  "test@example.org": { account: "u-1041", ou: "Member-University-A / Staff", contact: "noc@uni-a.example.ch" },
  "jane.doe@uni-b.example.ch": { account: "u-2087", ou: "Member-University-B / Research", contact: "security@uni-b.example.ch" },
  "ops@switch.ch": { account: "u-0001", ou: "SWITCH / SOC", contact: "soc@switch.ch" },
};

interface AccountOwner {
  email: string;
  account: string | null;
  ou: string;
  contact: string | null;
  known: boolean;
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { email, ...payload } = input;
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (normalizedEmail.length === 0) {
      throw new Error("A_RESOLVE_ACCOUNT_OWNER: email must be a non-empty string");
    }

    const hit = DIRECTORY[normalizedEmail];
    const account_owner: AccountOwner = hit
      ? { email: normalizedEmail, account: hit.account, ou: hit.ou, contact: hit.contact, known: true }
      : { email: normalizedEmail, account: null, ou: "unknown", contact: null, known: false };

    return { ...payload, account_owner };
  },
};
