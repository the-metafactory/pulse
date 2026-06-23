/**
 * A_POST_DISCORD — publish the journal entry to the public Discord server.
 *
 * Channel-friendly shape: the channel gets ONE compact teaser (headline,
 * narrative excerpt, link to the full entry on the build log). The full
 * journal goes into a thread under the teaser when the discord CLI supports
 * --create-thread (cortex PR #840); otherwise the link is the long form.
 *
 * Dry-run by default — posting to a public channel is opt-in via
 * discord_post: true (--post on the demo runner). Uses the cortex discord
 * CLI (~/bin/discord), same as P_ECOSYSTEM_DIGEST.
 */

import type { ActionContext, ShellResult } from "../../../src/types/action";

interface RepoTheme {
  repo: string;
  theme: string;
  highlights: string[];
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

interface JournalEntry {
  date: string;
  slug: string;
  headline: string;
  ecosystem_theme?: string;
  repo_themes?: RepoTheme[];
  external_contributions?: ExternalContribution[];
  narrative: string;
  highlights: string[];
  perspective: string;
  additions: string[];
  stats: { period_days: number; total_commits: number; active_repos: string[] };
  provenance: { draft_by: string; reviewed_by?: string; perspective_by?: string };
}

const DISCORD_LIMIT = 1900; // margin under the 2000-char message limit

function entryUrl(entry: JournalEntry, siteUrl: string): string {
  return `${siteUrl.replace(/\/$/, "")}/build-log/${entry.slug}.html`;
}

/** One compact channel message: headline, excerpt, top highlights, link. */
function renderTeaser(entry: JournalEntry, siteUrl: string): string {
  const excerpt = entry.narrative.length > 400 ? `${entry.narrative.slice(0, 400).trimEnd()}…` : entry.narrative;
  const lines = [
    `**🏗️ metafactory build journal — ${entry.date}**`,
    "",
    `**${entry.headline}**`,
    "",
    excerpt,
  ];
  const top = entry.highlights.slice(0, 3);
  if (top.length > 0) {
    lines.push("");
    for (const h of top) lines.push(`> ${h}`);
  }
  lines.push("", `Full entry: ${entryUrl(entry, siteUrl)}`);
  return splitToLimit(lines.join("\n"))[0]; // teaser is by construction short; belt and braces
}

/** The full journal, split into thread-sized messages. */
function renderFull(entry: JournalEntry): string[] {
  const head: string[] = [];
  if (entry.ecosystem_theme) head.push(`**${entry.ecosystem_theme}**`, "");
  head.push(entry.narrative);

  if (entry.repo_themes && entry.repo_themes.length > 0) {
    head.push("", "**By repository**");
    for (const r of entry.repo_themes) {
      head.push(`**${r.repo}** — ${r.theme}`);
      for (const h of r.highlights) head.push(`> ${h}`);
    }
  }

  if (entry.external_contributions && entry.external_contributions.length > 0) {
    head.push("", "**External contributions**");
    for (const c of entry.external_contributions) {
      head.push(`__${c.repo}__`);
      for (const p of c.merged_prs) head.push(`> PR [#${p.number}](${p.url}) — ${p.title} (@${p.author})`);
      for (const i of c.closed_issues) head.push(`> issue [#${i.number}](${i.url}) — ${i.title} (@${i.author})`);
    }
  }

  if (entry.highlights.length > 0) {
    head.push("", "**Shipped**");
    for (const h of entry.highlights) head.push(`> ${h}`);
  }

  const second: string[] = [];
  if (entry.perspective) {
    second.push(`**From the meta-factory stack** _(Andreas' agent)_`, "", entry.perspective);
  }
  if (entry.additions.length > 0) {
    second.push("");
    for (const a of entry.additions) second.push(`> ${a}`);
  }
  second.push(
    "",
    `_${entry.stats.total_commits} commits across ${entry.stats.active_repos.length} repos in ${entry.stats.period_days} days._`,
    `_Drafted by ${entry.provenance.draft_by}; reviewed by ${entry.provenance.reviewed_by ?? entry.provenance.perspective_by ?? "andreas' agent"}. Assembled by pulse P_BUILD_JOURNAL._`,
  );

  const sections = [head.join("\n"), second.join("\n")].flatMap(splitToLimit);
  const messages: string[] = [];
  let current = "";
  for (const s of sections) {
    if (current && current.length + 2 + s.length > DISCORD_LIMIT) {
      messages.push(current);
      current = s;
    } else {
      current = current ? `${current}\n\n${s}` : s;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** Split a block to chunks ≤ DISCORD_LIMIT, preferring line breaks, then hard slices. */
function splitToLimit(block: string): string[] {
  if (block.length <= DISCORD_LIMIT) return [block];
  const chunks: string[] = [];
  let current = "";
  for (const line of block.split("\n")) {
    // A single line longer than the limit gets hard-sliced.
    const pieces = line.length > DISCORD_LIMIT
      ? Array.from({ length: Math.ceil(line.length / DISCORD_LIMIT) }, (_, i) => line.slice(i * DISCORD_LIMIT, (i + 1) * DISCORD_LIMIT))
      : [line];
    for (const piece of pieces) {
      if (current && current.length + 1 + piece.length > DISCORD_LIMIT) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

type Shell = (cmd: string) => Promise<ShellResult>;

async function postViaTmpFile(shell: Shell, message: string, key: string, flags: string): Promise<ShellResult> {
  const tmpFile = `/tmp/build-journal-discord-${key}.txt`;
  await shell(`cat > '${tmpFile}' <<'PULSE_EOF'\n${message}\nPULSE_EOF`);
  const result = await shell(`bun ~/bin/discord post ${flags} "$(cat '${tmpFile}')" && rm -f '${tmpFile}'`);
  if (result.code !== 0) await shell(`rm -f '${tmpFile}'`);
  return result;
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { entry, discord_post, discord_channel, site_url, ...payload } = input;
    const journal = entry as JournalEntry;
    const channel = (discord_channel as string | undefined) ?? "general";
    const siteUrl = (site_url as string | undefined) ?? "https://stack.meta-factory.ai";

    const teaser = renderTeaser(journal, siteUrl);
    const full = renderFull(journal);

    if (!discord_post) {
      console.log(`\n📋 [A_POST_DISCORD] DRY RUN — teaser to #${channel}, ${full.length} message(s) to thread:`);
      console.log(`\n┄┄ teaser ${"┄".repeat(41)}\n${teaser}`);
      for (const m of full) console.log(`\n┄┄ thread ${"┄".repeat(41)}\n${m}`);
      console.log("┄".repeat(50));
      return { ...payload, entry, discord: { posted: false, dry_run: true, channel, thread: null, message_count: 1 + full.length } };
    }

    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("A_POST_DISCORD requires the 'shell' capability");

    // Probe: does the installed discord CLI support --create-thread (cortex PR #840)?
    const probe = await shell(`bun ~/bin/discord post --help`);
    const canThread = probe.code === 0 && probe.stdout.includes("--create-thread");

    if (!canThread) {
      // Older CLI: the teaser alone carries the link — the build log page is the long form.
      const result = await postViaTmpFile(shell, teaser, `${journal.date}-teaser`, `--channel ${channel}`);
      if (result.code !== 0) {
        throw new Error(`Discord teaser post failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
      }
      console.log(`📣 [A_POST_DISCORD] posted teaser to #${channel} (CLI lacks --create-thread; full entry is the build-log link)`);
      return { ...payload, entry, discord: { posted: true, dry_run: false, channel, thread: null, message_count: 1 } };
    }

    // Teaser + thread: post teaser, create thread from it, post the full entry inside.
    const threadName = `build journal ${journal.date}`;
    const teaserResult = await postViaTmpFile(
      shell,
      teaser,
      `${journal.date}-teaser`,
      `--channel ${channel} --create-thread "${threadName}"`,
    );
    if (teaserResult.code !== 0) {
      throw new Error(`Discord teaser post failed: ${(teaserResult.stderr || teaserResult.stdout).slice(0, 300)}`);
    }
    const threadId = teaserResult.stdout.match(/^thread:(\d+)$/m)?.[1];
    if (!threadId) {
      throw new Error(`Discord CLI did not return a thread id (stdout: ${teaserResult.stdout.slice(0, 200)})`);
    }

    for (const [i, message] of full.entries()) {
      const result = await postViaTmpFile(shell, message, `${journal.date}-${i}`, `--thread ${threadId}`);
      if (result.code !== 0) {
        throw new Error(`Discord thread post failed (message ${i + 1}/${full.length}): ${(result.stderr || result.stdout).slice(0, 300)}`);
      }
    }

    console.log(`📣 [A_POST_DISCORD] teaser in #${channel}, full entry in thread '${threadName}' (${full.length} message(s))`);
    return { ...payload, entry, discord: { posted: true, dry_run: false, channel, thread: threadId, message_count: 1 + full.length } };
  },
};
