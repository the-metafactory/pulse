/**
 * A_GATHER_FACTS — deterministic fact collection for the build journal.
 *
 * Walks the ecosystem repos and collects commit activity for the journal
 * period. Facts only — the narrative belongs to the agents downstream.
 * Missing repos are reported, not fatal: the journal covers what exists.
 */

import type { ActionContext } from "../../../src/types/action";

const DEFAULT_REPOS = ["pulse", "myelin", "cortex", "arc", "grove", "compass", "blueprint", "soma", "sage"];

interface RepoFacts {
  repo: string;
  commit_count: number;
  commits: string[];
  contributors: string[];
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { repos, days, work_dir, ...payload } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("A_GATHER_FACTS requires the 'shell' capability");

    const repoList = (repos as string[] | undefined) ?? DEFAULT_REPOS;
    const sinceDays = (days as number | undefined) ?? 7;
    const root = (work_dir as string | undefined) ?? `${process.env.HOME}/work/mf`;

    const active: RepoFacts[] = [];
    const quiet: string[] = [];
    const missing: string[] = [];

    for (const repo of repoList) {
      const dir = `${root}/${repo}`;
      const check = await shell(`test -d '${dir}/.git' && echo yes || echo no`);
      if (check.stdout.trim() !== "yes") {
        missing.push(repo);
        continue;
      }
      const log = await shell(
        `git -C '${dir}' log --since='${sinceDays} days ago' --no-merges --pretty=format:'%s§%an' main 2>/dev/null || git -C '${dir}' log --since='${sinceDays} days ago' --no-merges --pretty=format:'%s§%an'`,
      );
      const lines = log.stdout.split("\n").filter((l) => l.includes("§"));
      if (lines.length === 0) {
        quiet.push(repo);
        continue;
      }
      const commits = lines.map((l) => l.split("§")[0]);
      const contributors = [...new Set(lines.map((l) => l.split("§")[1]))];
      active.push({ repo, commit_count: commits.length, commits: commits.slice(0, 20), contributors });
    }

    const facts = {
      period_days: sinceDays,
      generated_at: new Date().toISOString(),
      active_repos: active,
      quiet_repos: quiet,
      missing_repos: missing,
      total_commits: active.reduce((n, r) => n + r.commit_count, 0),
    };

    console.log(
      `📊 [A_GATHER_FACTS] ${facts.total_commits} commits across ${active.length} active repos (${quiet.length} quiet, ${missing.length} missing) in last ${sinceDays}d`,
    );

    return { ...payload, facts };
  },
};
