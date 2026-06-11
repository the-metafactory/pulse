/**
 * A_NOTIFY_DISCORD — deliver a pipeline's output to one of OUR Discord
 * channels, with optional file attachments.
 *
 * This is the orchestration half of the control/data-plane split: the cortex
 * `discord` CLI owns the MECHANISM (it can post + attach files via the bot);
 * this action is the pipeline-facing surface that CALLS it — exactly how
 * A_NOTIFY_MATTERMOST delivers to Mattermost. Requires the `discord` CLI on
 * PATH (cortex ≥ v5.13.0 for `--file`).
 *
 * ── BOUNDARY (read this) ──────────────────────────────────────────────────
 * This action is for INTERNAL delivery to our own channels — a digest, a
 * report, a build artifact. It MUST NOT be wired into the diplomatic-pouch
 * pipelines. The pouch (Foreign Policy §1) is human-relayed by design: no
 * live API, no webhook, no auto-transmit. Auto-posting a pouch note to a
 * peer would break rung-1 trust. Keep this action on our side of the fence.
 *
 * Config resolution: explicit input fields, then env (DISCORD_CHANNEL,
 * DISCORD_SERVER). When no channel resolves the step is a passthrough no-op
 * (the demo runs offline). When configured, a failed post DOES fail the
 * pipeline — a system that thinks it delivered but didn't is worse than a
 * visible error (same posture as A_NOTIFY_MATTERMOST).
 */

import type { ActionContext } from "../../../src/types/action";

/** POSIX single-quote escaping — wraps an arg so the shell treats it literally. */
function shq(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { discord_channel, discord_message, discord_files, discord_server, ...payload } = input;

    const channel = (discord_channel as string | undefined) ?? process.env.DISCORD_CHANNEL;
    const server = (discord_server as string | undefined) ?? process.env.DISCORD_SERVER;
    const message = typeof discord_message === "string" ? discord_message : "";
    const files = Array.isArray(discord_files) ? (discord_files as unknown[]).filter((f): f is string => typeof f === "string") : [];

    if (!channel) {
      console.log("📭 [A_NOTIFY_DISCORD] no channel configured (discord_channel / DISCORD_CHANNEL) — skipping");
      return { ...payload, discord: { skipped: true, reason: "no channel" } };
    }
    if (message.length === 0 && files.length === 0) {
      console.log("📭 [A_NOTIFY_DISCORD] nothing to post (no message, no files) — skipping");
      return { ...payload, discord: { skipped: true, reason: "empty" } };
    }

    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("A_NOTIFY_DISCORD requires the 'shell' capability");

    const args = ["discord", "post", "--channel", shq(channel)];
    if (server) args.push("--server", shq(server));
    for (const f of files) args.push("--file", shq(f));
    if (message.length > 0) args.push(shq(message));

    const cmd = args.join(" ");
    const result = await shell(cmd);
    if (result.code !== 0) {
      throw new Error(
        `A_NOTIFY_DISCORD: discord CLI exited ${result.code} — ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      );
    }

    console.log(`📬 [A_NOTIFY_DISCORD] posted to #${channel}${files.length > 0 ? ` (+${files.length} file${files.length === 1 ? "" : "s"})` : ""}`);
    return {
      ...payload,
      discord: { skipped: false, channel, files: files.length, server: server ?? null },
    };
  },
};
