/**
 * A_DISPOSITION — deterministic triage of code-review findings.
 *
 * Reads the `code-review.*` agent step's verdict block (an AgentTaskResult)
 * and classifies each finding into:
 *   - fix-small  → cheap, in-cycle correction the dev agent re-implements
 *   - defer-big  → architectural / scope-expanding; file a follow-up issue
 *
 * This is the design §3.3 `A_DISPOSITION` D-node: it produces a *plan*, it does
 * not *act* on it. In the full loop the driver (pilot) reads `disposition` and
 * decides whether to re-dispatch `dev.implement` (fix cycle) or proceed — pulse
 * itself cannot branch on this output yet (pipeline.yaml gap G2/G4).
 *
 * Severity → bucket mapping is deliberately conservative: anything blocking or
 * high is a fix-small (must be addressed before merge); medium/low findings that
 * widen scope are deferred. The classifier is total: an empty / approved review
 * yields an empty plan with proceed=true.
 */

import type { ActionContext } from "../../../src/types/action";
import type { AgentTaskResult } from "../../../src/types/agent";

interface Finding {
  id?: string;
  severity?: "blocking" | "high" | "medium" | "low" | string;
  summary?: string;
  /** Reviewer hint: does addressing this expand scope? */
  scope_expanding?: boolean;
}

interface ReviewOutput {
  verdict?: "approved" | "changes-requested" | string;
  findings?: Finding[];
}

function isFixSmall(f: Finding): boolean {
  const sev = (f.severity ?? "").toLowerCase();
  if (sev === "blocking" || sev === "high") return true;
  // medium/low: fix in-cycle only when it does not expand scope.
  return f.scope_expanding !== true;
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { review, ...payload } = input;
    const result = review as AgentTaskResult;
    const out = (typeof result?.output === "string"
      ? JSON.parse(result.output)
      : result?.output) as ReviewOutput | undefined;

    const verdict = out?.verdict ?? "approved";
    const findings = Array.isArray(out?.findings) ? out!.findings! : [];

    const fixSmall = findings.filter(isFixSmall);
    const deferBig = findings.filter((f) => !isFixSmall(f));

    const disposition = {
      verdict,
      // proceed=true means review cleared (or no actionable findings).
      // The driver uses this to decide fix-cycle vs advance — pulse cannot
      // branch on it (gap G2). proceed is advisory data, not control flow.
      proceed: verdict === "approved" && fixSmall.length === 0,
      fix_small: fixSmall.map((f) => ({ id: f.id, severity: f.severity, summary: f.summary })),
      defer_big: deferBig.map((f) => ({ id: f.id, severity: f.severity, summary: f.summary })),
      counts: { fix_small: fixSmall.length, defer_big: deferBig.length, total: findings.length },
    };

    return { ...payload, review, disposition };
  },
};
