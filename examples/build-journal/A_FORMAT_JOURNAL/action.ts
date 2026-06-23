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

interface RepoTheme {
  repo: string;
  theme: string;
  highlights?: string[];
}

interface DraftOutput {
  headline?: string;
  ecosystem_theme?: string;
  repo_themes?: RepoTheme[];
  narrative?: string;
  highlights?: string[];
}

interface PerspectiveOutput {
  perspective?: string;
  remaining?: string[];
  additions?: string[];
  sign_off?: boolean;
}

interface ExternalItem {
  number: number;
  title: string;
  author: string;
  url: string;
}

interface ExternalContribution {
  repo: string;
  merged_prs: ExternalItem[];
  closed_issues: ExternalItem[];
}

/**
 * Parse agent output: object as-is; JSON string parsed; a ```json block
 * embedded anywhere in surrounding prose is extracted (real models often
 * preface the JSON with commentary); pure prose kept raw.
 */
/**
 * Resolve a collected agent step into its output + identity. The agent
 * primitive stores only the result VALUE under the collect field
 * (primitive-runner.ts) — so `draft` is the output itself, not the full
 * AgentTaskResult. Older runs collected the whole record; accept both by
 * discriminating on `task_id` (present only on the record).
 */
function resolveAgent(collected: unknown): { output: unknown; agent?: string; model?: string } {
  if (collected && typeof collected === "object" && "task_id" in collected && "output" in collected) {
    const r = collected as AgentTaskResult;
    return { output: r.output, agent: r.agent, model: r.model };
  }
  return { output: collected };
}

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
    // Prose comes from the de-AI'd `humanized` step; STRUCTURE (repo_themes)
    // comes from the last content step `revised2` — humanize is prose-only and
    // must not be able to drop the per-repo breakdown. Every prose field falls
    // back through revised2 → draft so one step dropping a field never blanks
    // the entry. The review note shown is the SECOND review (the findings are
    // already folded into the body, not tacked on). External PR/issue links
    // come straight from the facts — real gh URLs, no agent-cited numbers.
    const { humanized, revised2, draft, second_review, approval, facts, ...payload } = input;
    const reviewResult = resolveAgent(second_review);
    const gate = approval as GateResult;
    const factsObj = facts as {
      period_days?: number;
      total_commits?: number;
      active_repos?: Array<{ repo: string; commit_count: number }>;
      external_contributions?: ExternalContribution[];
      external_contributors?: string[];
    };

    // Layered sources, freshest first. A field is taken from the first layer
    // that actually has it — so a step that drops a field degrades gracefully.
    const h = parseAgentJson<DraftOutput>(resolveAgent(humanized).output);
    const r2 = parseAgentJson<DraftOutput>(resolveAgent(revised2).output);
    const d0 = parseAgentJson<DraftOutput>(resolveAgent(draft).output);
    const p = parseAgentJson<PerspectiveOutput>(reviewResult.output);

    const firstStr = (...vals: Array<string | undefined>) => vals.find((v) => v && v.trim().length > 0) ?? "";
    const firstArr = <T,>(...vals: Array<T[] | undefined>) => vals.find((v) => v && v.length > 0) ?? [];

    // repo_themes is additive COVERAGE — a later step must never shrink it below
    // an earlier one. Keep the layer with the most repos (tie → the more-refined
    // revised2, then draft). humanize is prose-only and carries none.
    const repoThemes = [r2.repo_themes, d0.repo_themes]
      .filter((v): v is NonNullable<typeof v> => Array.isArray(v) && v.length > 0)
      .sort((a, b) => b.length - a.length)[0] ?? [];

    const date = new Date().toISOString().slice(0, 10);
    const entry = {
      date,
      slug: `${date}-build-journal`,
      headline: firstStr(h.headline, r2.headline, d0.headline) || `Build journal — ${date}`,
      ecosystem_theme: firstStr(h.ecosystem_theme, r2.ecosystem_theme, d0.ecosystem_theme),
      repo_themes: repoThemes.map((r) => ({
        repo: r.repo,
        theme: r.theme,
        highlights: r.highlights ?? [],
      })),
      external_contributions: factsObj.external_contributions ?? [],
      external_contributors: factsObj.external_contributors ?? [],
      narrative: firstStr(h.narrative, r2.narrative, d0.narrative) || "(no narrative)",
      highlights: firstArr(h.highlights, r2.highlights, d0.highlights),
      // Both federation reviews are folded INTO the body (revise + revise2), so
      // no tacked-on perspective block. The review survives as provenance + sign_off.
      perspective: "",
      additions: [],
      sign_off: p.sign_off ?? false,
      stats: {
        period_days: factsObj.period_days ?? 7,
        total_commits: factsObj.total_commits ?? 0,
        active_repos: (factsObj.active_repos ?? []).map((r) => `${r.repo} (${r.commit_count})`),
      },
      provenance: {
        draft_by: `jc's agent (${resolveAgent(humanized).agent ?? "fleet"}, ${resolveAgent(humanized).model ?? "?"})`,
        reviewed_by: `andreas' agent (${reviewResult.agent ?? "fleet"}, ${reviewResult.model ?? "?"}) — two review passes, both folded into the text, via federated.andreas.meta-factory${p.sign_off ? " (signed off)" : " (open items noted)"}`,
        approved_by_gate: gate.name,
        approved_at: gate.closed_at,
        pipeline: "P_BUILD_JOURNAL (pulse) — draft → review → revise → second-review → humanize",
      },
    };

    console.log(
      `📰 [A_FORMAT_JOURNAL] entry '${entry.headline}' — sign_off=${entry.sign_off}, ${entry.external_contributions.length} repo(s) with external work`,
    );
    return { ...payload, entry };
  },
};
