/**
 * A_NOTIFY_MATTERMOST — post the published advisory to a Mattermost channel.
 *
 * Config resolution order: explicit input fields, then environment variables
 * (MATTERMOST_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_CHANNEL_ID). When any of
 * the three is missing the step is a passthrough no-op — the demo must run
 * offline without a Mattermost instance. When configured, a failed post DOES
 * fail the pipeline: a SOC that thinks it notified members but didn't is
 * worse than a visible error.
 */

import type { ActionContext } from "../../../src/types/action";

interface PublishedAdvisory {
  title?: string;
  body?: string;
  enrichment?: string;
  analyst_notes?: string;
  approved_by_gate?: string;
  approved_at?: string;
}

function formatMessage(advisory: PublishedAdvisory): string {
  const lines = [
    `#### ${advisory.title ?? "CommunitySOC Advisory"}`,
    "",
    advisory.body ?? "(no advisory text)",
  ];
  if (advisory.enrichment) lines.push("", `**Enrichment:** ${advisory.enrichment}`);
  if (advisory.analyst_notes) lines.push("", `**Analyst notes:** ${advisory.analyst_notes}`);
  if (advisory.approved_by_gate) {
    lines.push("", `_Approved via gate \`${advisory.approved_by_gate}\`${advisory.approved_at ? ` at ${advisory.approved_at}` : ""}_`);
  }
  return lines.join("\n");
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { published, mattermost_url, mattermost_channel_id, mattermost_bot_token, ...payload } = input;
    const advisory = (published ?? {}) as PublishedAdvisory;

    const url = (mattermost_url as string | undefined) ?? process.env.MATTERMOST_URL;
    const channelId = (mattermost_channel_id as string | undefined) ?? process.env.MATTERMOST_CHANNEL_ID;
    const token = (mattermost_bot_token as string | undefined) ?? process.env.MATTERMOST_BOT_TOKEN;

    if (!url || !channelId || !token) {
      const missing = [
        !url && "MATTERMOST_URL",
        !channelId && "MATTERMOST_CHANNEL_ID",
        !token && "MATTERMOST_BOT_TOKEN",
      ].filter(Boolean);
      console.log(`📭 [A_NOTIFY_MATTERMOST] not configured (missing: ${missing.join(", ")}) — skipping`);
      return { ...payload, published, mattermost: { skipped: true, missing } };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_NOTIFY_MATTERMOST requires the 'fetch' capability");

    const res = await fetchFn(`${url.replace(/\/$/, "")}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: channelId,
        message: formatMessage(advisory),
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new Error(`Mattermost post failed: HTTP ${res.status} — ${detail}`);
    }

    const post = (await res.json()) as { id?: string; channel_id?: string; create_at?: number };
    console.log(`📬 [A_NOTIFY_MATTERMOST] posted advisory to channel ${channelId} (post ${post.id ?? "?"})`);

    return {
      ...payload,
      published,
      mattermost: { skipped: false, post_id: post.id, channel_id: post.channel_id, create_at: post.create_at },
    };
  },
};
