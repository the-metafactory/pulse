/**
 * A_FORMAT_JOURNAL — merge both agents' contributions into the final entry.
 *
 * Provenance is the point: each section records which principal's agent
 * produced it. The entry is the single source for both publish steps
 * (Discord + build log page).
 */

import type { ActionContext } from "../../../src/types/action";
import type { AgentTaskResult } from "../../../src/types/agent";
import type { GateResult } from "../../../src/types/pipeline";

interface DraftOutput {
  headline?: string;
  narrative?: string;
  highlights?: string[];
}

interface PerspectiveOutput {
  perspective?: string;
  additions?: string[];
  sign_off?: boolean;
}

/**
 * Parse agent output: object as-is; JSON string parsed; a ```json block
 * embedded anywhere in surrounding prose is extracted (real models often
 * preface the JSON with commentary); pure prose kept raw.
 */
function parseAgentJson<T>(output: unknown): T {
  if (typeof output !== "string") return (output ?? {}) as T;
  const cleaned = output.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (_err) {
    const embedded = output.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
    if (embedded) {
      try {
        return JSON.parse(embedded[1]) as T;
      } catch (_err2) {
        // fenced block wasn't valid JSON either — fall through to prose
      }
    }
    // model returned prose — surface it as the main text field downstream
    return { narrative: cleaned, perspective: cleaned } as T;
  }
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { draft, perspective, approval, facts, ...payload } = input;
    const draftResult = draft as AgentTaskResult;
    const perspectiveResult = perspective as AgentTaskResult;
    const gate = approval as GateResult;
    const factsObj = facts as { period_days?: number; total_commits?: number; active_repos?: Array<{ repo: string; commit_count: number }> };

    const d = parseAgentJson<DraftOutput>(draftResult.output);
    const p = parseAgentJson<PerspectiveOutput>(perspectiveResult.output);

    const date = new Date().toISOString().slice(0, 10);
    const entry = {
      date,
      slug: `${date}-build-journal`,
      headline: d.headline ?? `Build journal — ${date}`,
      narrative: d.narrative ?? "(no narrative)",
      highlights: d.highlights ?? [],
      perspective: p.perspective ?? "(no perspective)",
      additions: p.additions ?? [],
      sign_off: p.sign_off ?? false,
      stats: {
        period_days: factsObj.period_days ?? 7,
        total_commits: factsObj.total_commits ?? 0,
        active_repos: (factsObj.active_repos ?? []).map((r) => `${r.repo} (${r.commit_count})`),
      },
      provenance: {
        draft_by: `jc's agent (${draftResult.agent ?? "fleet"}, ${draftResult.model ?? "?"})`,
        perspective_by: `andreas' agent (${perspectiveResult.agent ?? "fleet"}, ${perspectiveResult.model ?? "?"}) — via federated.andreas.meta-factory`,
        approved_by_gate: gate.name,
        approved_at: gate.closed_at,
        pipeline: "P_BUILD_JOURNAL (pulse)",
      },
    };

    console.log(`📰 [A_FORMAT_JOURNAL] entry '${entry.headline}' — sign_off=${entry.sign_off}`);
    return { ...payload, entry };
  },
};
