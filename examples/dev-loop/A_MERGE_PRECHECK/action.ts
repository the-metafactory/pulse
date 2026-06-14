/**
 * A_MERGE_PRECHECK — deterministic pre-merge gate (design §3.5).
 *
 * The mechanical half of the two-of-two merge gate: before the approver-bot
 * (`merge.approve`) is asked to squash, this D-node confirms the PR is actually
 * mergeable. Three checks, all deterministic, all reading data the GH tap and
 * the dev step already put on the bus:
 *
 *   - ci_green   : every required check has concluded success
 *   - mergeable  : GitHub reports MERGEABLE (no conflicts)
 *   - fresh      : the PR's head SHA is not stale relative to base — guards the
 *                  "squash on a stale branch silently overwrites interim work"
 *                  failure called out in cortex CLAUDE.md (PR #120 data loss).
 *
 * It does NOT merge — that authority stays with `merge.approve` + branch
 * protection. It emits a `precheck` block: { ok, checks }. When `merge_state`
 * is absent (offline demo / dry-run) it treats the slice as clean so the
 * pipeline validates and round-trips without a live GH read.
 */

import type { ActionContext } from "../../../src/types/action";
import { parseCollectedValue } from "../parse-collected";

interface ImplementOutput {
  pr?: number;
  head_sha?: string;
}

interface MergeState {
  /** CI rollup: did all required checks pass? */
  ci_conclusion?: "success" | "failure" | "pending" | string;
  /** GitHub mergeable state. */
  mergeable?: boolean;
  /** Commits the base branch is ahead of the PR head (staleness). */
  behind_by?: number;
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { implement, merge_state, ...payload } = input;

    // `implement` is the agent step's RESULT VALUE (collect stores result.output,
    // not the transport envelope) — structured object or JSON string.
    const implOut = parseCollectedValue<ImplementOutput>(implement);
    const pr = implOut?.pr;

    // Offline / dry-run default: no live GH read → assume clean.
    const state = (merge_state as MergeState | undefined) ?? {
      ci_conclusion: "success",
      mergeable: true,
      behind_by: 0,
    };

    const ci_green = state.ci_conclusion === "success";
    const mergeable = state.mergeable === true;
    const fresh = (state.behind_by ?? 0) === 0;

    const checks = { ci_green, mergeable, fresh };
    const ok = ci_green && mergeable && fresh;

    const precheck = {
      pr,
      ok,
      checks,
      // Human-legible reason on failure — the approver / driver surfaces this.
      reason: ok
        ? "all prechecks passed"
        : [
            ci_green ? null : "CI not green",
            mergeable ? null : "not MERGEABLE (conflicts)",
            fresh ? null : `stale: base ahead by ${state.behind_by}`,
          ]
            .filter(Boolean)
            .join("; "),
    };

    return { ...payload, implement, precheck };
  },
};
