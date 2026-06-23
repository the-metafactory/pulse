/**
 * A_GATHER_FACTS — deterministic fact collection for the build journal.
 *
 * Discovers the ecosystem's repos from GitHub and collects commit activity +
 * external contributions for the journal period. Facts only — the narrative
 * belongs to the agents downstream.
 *
 * Repo selection is AUTO-DISCOVERED, not a hardcoded list: every non-archived
 * org repo pushed within the window is a candidate, MINUS a private exclude
 * list (repos we never want surfaced in a public journal). This is why a new
 * repo (dev-loop, yarrow, …) shows up automatically instead of being silently
 * dropped. Commits are read from GitHub (origin default branch), so a repo
 * does NOT need to be cloned locally to be covered.
 */

import type { ActionContext } from "../../../src/types/action";

const GH_ORG = "the-metafactory";
// The two principals whose agents author this journal — everyone else is "external".
const PRINCIPAL_LOGINS = new Set(["jcfischer", "mellanon"]);

// Repos that must NEVER appear in the public build journal, even when active.
// `.github` is org meta; the rest are private/internal or the journal's own
// site repo. Add more here, or per-run via the BUILD_JOURNAL_EXCLUDE env var
// (comma-separated) or the `exclude` action input.
const DEFAULT_EXCLUDE = [
  ".github",
  "myelin-cortex-site", // the build-log site repo itself
  "grove-auth",
  "grove-v2",
  "grove",
  "test-rig",
  "metafactory-admin",
  "admin",
];

type Shell = NonNullable<ActionContext["capabilities"]["shell"]>;

const isExternal = (login: string | undefined): boolean =>
  !!login && !PRINCIPAL_LOGINS.has(login) && !login.endsWith("[bot]");

interface RepoFacts {
  repo: string;
  commit_count: number;
  commits: string[];
  contributors: string[];
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
 * Discover candidate repos: every non-archived org repo pushed within the
 * window, minus the exclude set. Best-effort — if discovery fails (gh unauthed
 * / offline) the caller falls back to an explicit repo list.
 */
async function discoverRepos(shell: Shell, sinceTs: string, exclude: Set<string>): Promise<string[]> {
  const res = await shell(
    `gh repo list '${GH_ORG}' --no-archived --limit 300 --json name,pushedAt --jq '.[] | select(.pushedAt >= "${sinceTs}") | .name' 2>/dev/null`,
  );
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !exclude.has(s));
}

/**
 * Gather non-merge commits on a repo's default branch since the window start,
 * straight from GitHub — no local clone required. Returns subjects + the set
 * of contributor logins. On error (rate limit / missing) returns empty.
 */
async function gatherCommits(shell: Shell, repo: string, sinceTs: string): Promise<{ commits: string[]; contributors: string[] }> {
  try {
    const res = await shell(
      `gh api 'repos/${GH_ORG}/${repo}/commits?since=${sinceTs}&per_page=100' --jq '.[] | select((.commit.message|startswith("Merge "))|not) | "\\(.commit.message|split("\\n")[0])§\\(.author.login // .commit.author.name)"' 2>/dev/null`,
    );
    const lines = res.stdout.split("\n").filter((l) => l.includes("§"));
    const commits = lines.map((l) => l.split("§")[0]);
    const contributors = [...new Set(lines.map((l) => l.split("§")[1]).filter(Boolean))];
    return { commits, contributors };
  } catch (err) {
    console.warn(`⚠️  [A_GATHER_FACTS] commit lookup failed for ${GH_ORG}/${repo}: ${(err as Error).message}`);
    return { commits: [], contributors: [] };
  }
}

/**
 * External contributions = merged PRs and closed issues authored by anyone
 * outside the two principals (jcfischer/mellanon) in the journal window.
 * Best-effort: needs `gh` auth + network. A repo that errors is skipped, not
 * fatal — the journal still covers what we could read.
 */
async function gatherExternal(shell: Shell, repos: string[], sinceDate: string): Promise<ExternalContribution[]> {
  const out: ExternalContribution[] = [];
  for (const repo of repos) {
    const slug = `${GH_ORG}/${repo}`;
    try {
      const prRes = await shell(
        `gh pr list -R '${slug}' --state merged --search 'merged:>=${sinceDate}' --json number,title,author,url --limit 100 2>/dev/null`,
      );
      const issRes = await shell(
        `gh issue list -R '${slug}' --state closed --search 'closed:>=${sinceDate}' --json number,title,author,url --limit 100 2>/dev/null`,
      );
      type GhItem = { number: number; title: string; url: string; author?: { login?: string } };
      const prs = JSON.parse(prRes.stdout.trim() || "[]") as GhItem[];
      const issues = JSON.parse(issRes.stdout.trim() || "[]") as GhItem[];

      const merged_prs = prs
        .filter((p) => isExternal(p.author?.login))
        .map((p) => ({ number: p.number, title: p.title, author: p.author!.login!, url: p.url }));
      const closed_issues = issues
        .filter((i) => isExternal(i.author?.login))
        .map((i) => ({ number: i.number, title: i.title, author: i.author!.login!, url: i.url }));

      if (merged_prs.length > 0 || closed_issues.length > 0) {
        out.push({ repo, merged_prs, closed_issues });
      }
    } catch (err) {
      // gh missing/unauthed/rate-limited or repo not on the org — skip this
      // repo's external data rather than failing the whole journal.
      console.warn(`⚠️  [A_GATHER_FACTS] external lookup failed for ${slug}: ${(err as Error).message}`);
    }
  }
  return out;
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { repos, days, exclude, ...payload } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("A_GATHER_FACTS requires the 'shell' capability");

    const sinceDays = (days as number | undefined) ?? 7;
    const sinceDate = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const sinceTs = `${sinceDate}T00:00:00Z`;

    // Private exclude list: defaults + env (comma-separated) + explicit input.
    const envExclude = (process.env.BUILD_JOURNAL_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const excludeSet = new Set<string>([...DEFAULT_EXCLUDE, ...envExclude, ...((exclude as string[] | undefined) ?? [])]);

    // Repo selection: an explicit `repos` input wins; otherwise auto-discover
    // active org repos minus the exclude set.
    let repoList = repos as string[] | undefined;
    let discovered = false;
    if (!repoList || repoList.length === 0) {
      repoList = (await discoverRepos(shell, sinceTs, excludeSet)).filter((r) => !excludeSet.has(r));
      discovered = true;
    } else {
      repoList = repoList.filter((r) => !excludeSet.has(r));
    }

    const active: RepoFacts[] = [];
    const quiet: string[] = [];

    for (const repo of repoList) {
      const { commits, contributors } = await gatherCommits(shell, repo, sinceTs);
      if (commits.length === 0) {
        quiet.push(repo);
        continue;
      }
      active.push({ repo, commit_count: commits.length, commits: commits.slice(0, 20), contributors });
    }

    // External contributions across the SAME discovered set — community PRs/issues
    // in any active repo, not just a curated few.
    const external_contributions = await gatherExternal(shell, repoList, sinceDate);
    const external_contributors = [
      ...new Set(
        external_contributions.flatMap((e) => [
          ...e.merged_prs.map((p) => p.author),
          ...e.closed_issues.map((i) => i.author),
        ]),
      ),
    ];

    const facts = {
      period_days: sinceDays,
      generated_at: new Date().toISOString(),
      repo_selection: discovered ? "auto-discovered" : "explicit",
      excluded_repos: [...excludeSet],
      active_repos: active,
      quiet_repos: quiet,
      total_commits: active.reduce((n, r) => n + r.commit_count, 0),
      external_contributions,
      external_contributors,
    };

    console.log(
      `📊 [A_GATHER_FACTS] ${facts.total_commits} commits across ${active.length} active repos ` +
        `(${quiet.length} quiet; ${discovered ? "auto-discovered" : "explicit"}; ${excludeSet.size} excluded: ${[...excludeSet].join(", ")}) ` +
        `in last ${sinceDays}d; ${external_contributors.length} external contributor(s): ${external_contributors.join(", ") || "none"}`,
    );

    return { ...payload, facts };
  },
};
