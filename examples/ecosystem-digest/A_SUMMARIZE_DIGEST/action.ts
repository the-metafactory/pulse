import type { ActionContext } from "../../../src/types/action";

interface BlueprintHealth {
  repos: Array<{ repo: string; total: number; done: number; inProgress: number; ready: number; blocked: number }>;
  summary: { total: number; done: number; inProgress: number; ready: number; blocked: number };
}

interface Input {
  repoActivity: any[];
  blueprintStatus: Record<string, { done: string[]; inProgress: string[]; planned: string[] }>;
  blueprintHealth?: BlueprintHealth | null;
  since?: string;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { repoActivity, blueprintStatus, blueprintHealth, since, ...upstream } = input;
    const llm = ctx.capabilities.llm;
    if (!llm) throw new Error("LLM capability required");

    // Build context for the LLM
    const activitySummary = repoActivity.map((r) => {
      const parts = [`## ${r.repo}`];
      if (r.commits?.length) parts.push(`Commits: ${r.commits.length} (latest: ${r.commits.slice(0, 3).map((c: any) => c.message).join("; ")})`);
      if (r.prsMerged?.length) parts.push(`PRs merged: ${r.prsMerged.map((p: any) => `#${p.number} ${p.title}`).join(", ")}`);
      if (r.prsOpen?.length) parts.push(`PRs open: ${r.prsOpen.map((p: any) => `#${p.number} ${p.title}`).join(", ")}`);
      if (r.issuesOpened?.length) parts.push(`Open issues: ${r.issuesOpened.map((i: any) => `#${i.number} ${i.title}`).join(", ")}`);
      if (r.issuesClosed?.length) parts.push(`Closed issues: ${r.issuesClosed.map((i: any) => `#${i.number}`).join(", ")}`);
      return parts.join("\n");
    }).join("\n\n");

    const blueprintSummary = Object.entries(blueprintStatus).map(([repo, status]) => {
      const parts = [`## ${repo}`];
      if (status.inProgress.length) parts.push(`In progress: ${status.inProgress.join(", ")}`);
      if (status.planned.length) parts.push(`Planned (${status.planned.length} features)`);
      parts.push(`Done: ${status.done.length} features`);
      return parts.join("\n");
    }).join("\n\n");

    // Build blueprint health section if available (from blueprint CLI)
    let healthSection = "";
    if (blueprintHealth?.repos) {
      const lines = blueprintHealth.repos.map((r) =>
        `${r.repo}: ${r.done}/${r.total} done, ${r.ready} ready, ${r.blocked} blocked`
      );
      const s = blueprintHealth.summary;
      lines.push(`TOTAL: ${s.done}/${s.total} done, ${s.ready} ready, ${s.blocked} blocked`);
      healthSection = `\n\n## Blueprint Health (cross-repo dependency graph)\n${lines.join("\n")}`;
    }

    const prompt = `You are a development team assistant for the metafactory ecosystem — a marketplace for agentic components.

Analyze this ecosystem activity and produce a concise daily digest.

## Recent Activity
${activitySummary}

## Blueprint Status (per-repo feature roadmap)
${blueprintSummary}${healthSection}

Note: Agent rules (CLAUDE.md) for each repo are managed by arc via agents-md.yaml. When compass templates or SOPs change, operators run \`arc upgrade compass\` to regenerate CLAUDE.md across repos.

Produce a JSON response with:
- "summary": A 2-3 sentence overview of what happened and what's moving
- "highlights": Array of 3-5 notable items (merged PRs, completed features, new issues) as short strings
- "blockers": Array of items that might need attention (stale PRs, blocked features, failing patterns) as short strings. Empty array if none.
- "nextUp": Array of 2-3 things the team should focus on next based on the blueprint

Return ONLY valid JSON.`;

    const result = await llm(prompt, {
      tier: "standard",
      system: "You are a concise, actionable development digest generator. Focus on what matters. No fluff.",
      json: true,
    });

    const parsed = result.json as {
      summary?: string;
      highlights?: string[];
      blockers?: string[];
      nextUp?: string[];
    } | undefined;

    return {
      ...upstream,
      repoActivity,
      blueprintStatus,
      since,
      summary: parsed?.summary || "Unable to generate summary",
      highlights: parsed?.highlights || [],
      blockers: parsed?.blockers || [],
      nextUp: parsed?.nextUp || [],
      summarizedAt: new Date().toISOString(),
    };
  },
};
