/**
 * A_REQUEST_RESET — queue an IAM force-password-reset for a resolved account.
 *
 * D-class block (design/soc-demo-mm-composer.md §4) closing the catalog gap the
 * real-LLM composer flagged on credential-leak scenarios ("no credential-reset
 * block"). Input: `account_owner` (from A_RESOLVE_ACCOUNT_OWNER). It does NOT
 * perform a reset — the reset is a human/IAM action that belongs behind a
 * `gate:`; this block records the QUEUED request (a ticket-shaped intent), the
 * offline stand-in for an IdP/IAM provisioning call. No env, no network.
 *
 * An unknown owner ({ known: false }) is a documented skip
 * ({ status: "skipped" }), never an error — you can't reset an account you
 * couldn't resolve.
 */

import type { ActionContext } from "../../../../src/types/action";

interface ResetRequest {
  account: string | null;
  status: "queued" | "skipped";
  reason?: string;
  queued_ref?: string;
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { account_owner, ...payload } = input;
    if (account_owner === null || typeof account_owner !== "object") {
      throw new Error("A_REQUEST_RESET: account_owner must be an object (from A_RESOLVE_ACCOUNT_OWNER)");
    }

    const owner = account_owner as { account?: unknown; known?: unknown };
    const account = typeof owner.account === "string" ? owner.account : null;

    const reset_request: ResetRequest =
      owner.known === true && account !== null
        ? { account, status: "queued", queued_ref: `IAM-RESET-${account}` }
        : { account, status: "skipped", reason: "owner not resolved — cannot queue a reset" };

    return { ...payload, account_owner, reset_request };
  },
};
