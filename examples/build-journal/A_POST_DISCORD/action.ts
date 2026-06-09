/**
 * A_POST_DISCORD — publish the journal entry to the public Discord server.
 *
 * Dry-run by default (prints the rendered message) — posting to a public
 * channel is opt-in via discord_post: true (--post on the demo runner).
 * Uses the cortex discord CLI (~/bin/discord), same as P_ECOSYSTEM_DIGEST.
 */

import type { ActionContext } from "../../../src/types/action";

interface JournalEntry {
  date: string;
  headline: string;
  narrative: string;
  highlights: string[];
  perspective: string;
  additions: string[];
  stats: { period_days: number; total_commits: number; active_repos: string[] };
  provenance: { draft_by: string; perspective_by: string };
}

const DISCORD_LIMIT = 1900; // margin under the 2000-char message limit

function renderMessages(entry: JournalEntry): string[] {
  const head: string[] = [
    `**🏗️ metafactory build journal — ${entry.date}**`,
    "",
    `**${entry.headline}**`,
    "",
    entry.narrative,
  ];
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
    `_Drafted by ${entry.provenance.draft_by}; perspective by ${entry.provenance.perspective_by}. Assembled by pulse P_BUILD_JOURNAL._`,
  );

  // Pack sections into <2000-char messages
  const sections = [head.join("\n"), second.join("\n")];
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

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { entry, discord_post, discord_channel, ...payload } = input;
    const journal = entry as JournalEntry;
    const channel = (discord_channel as string | undefined) ?? "general";
    const messages = renderMessages(journal);

    if (!discord_post) {
      console.log(`\n📋 [A_POST_DISCORD] DRY RUN — would post ${messages.length} message(s) to #${channel}:`);
      for (const m of messages) console.log(`\n${"┄".repeat(50)}\n${m}`);
      console.log("┄".repeat(50));
      return { ...payload, entry, discord: { posted: false, dry_run: true, channel, message_count: messages.length } };
    }

    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("A_POST_DISCORD requires the 'shell' capability");

    for (const [i, message] of messages.entries()) {
      const tmpFile = `/tmp/build-journal-discord-${journal.date}-${i}.txt`;
      await shell(`cat > '${tmpFile}' <<'PULSE_EOF'\n${message}\nPULSE_EOF`);
      const result = await shell(`bun ~/bin/discord post --channel ${channel} "$(cat '${tmpFile}')" && rm -f '${tmpFile}'`);
      if (result.code !== 0) {
        await shell(`rm -f '${tmpFile}'`);
        throw new Error(`Discord post failed (message ${i + 1}/${messages.length}): ${result.stderr.slice(0, 300)}`);
      }
    }

    console.log(`📣 [A_POST_DISCORD] posted ${messages.length} message(s) to #${channel}`);
    return { ...payload, entry, discord: { posted: true, dry_run: false, channel, message_count: messages.length } };
  },
};
