/**
 * A_REQUEST_RESET — queue an IAM force-password-reset for a resolved account.
 *
 * Implementation notes (the full contract is in action.json): records a
 * QUEUED reset intent from `account_owner`; it performs no reset and gates
 * nothing (a `gate:` before it is a pipeline-authoring convention, not a
 * precondition). Offline, fail-soft — an unresolved owner / empty account id
 * is a documented skip ({ status: "skipped" }), never an error. A stub-safe
 * addition closing the credential-leak catalog gap (no reset block existed).
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
    const account =
      typeof owner.account === "string" && owner.account.trim().length > 0
        ? owner.account.trim()
        : null;

    const reset_request: ResetRequest =
      owner.known === true && account !== null
        ? { account, status: "queued", queued_ref: `IAM-RESET-${account}` }
        : { account, status: "skipped", reason: "owner not resolved (no account id) — cannot queue a reset" };

    return { ...payload, account_owner, reset_request };
  },
};
