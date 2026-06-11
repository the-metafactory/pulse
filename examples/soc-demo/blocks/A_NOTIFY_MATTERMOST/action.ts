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

import type { ActionContext } from "../../../../src/types/action";

interface AdvisoryDoc {
  markdown?: string;
}

// Two independent ceilings, measured against securechat-test (2026-06-10) —
// measurement provenance: examples/soc-triage/A_NOTIFY_MATTERMOST git history
// (this block is the soc-demo copy; the numbers were binary-searched live):
// the API validates MaxPostSize (16383) and returns a clean 400 above it,
// but the SAVE layer 500s ("app.post.save.app_error") when the DB column
// overflows — binary-searched to ~4000 characters (3000 two-byte chars
// passed, 4100 ASCII failed, so the column counts characters, not bytes).
// Chunk limits stay under the measured save ceiling with margin; the byte
// check is belt-and-braces for servers whose column counts bytes instead.
const MM_MAX_CHARS = 3800;
const MM_MAX_BYTES = 15000;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** Strip control characters Postgres/Mattermost reject at save time (HTTP 500), keep \n and \t. */
function sanitize(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Split a message into chunks under both char and byte ceilings, preferring line boundaries. */
function splitMessage(message: string): string[] {
  const fits = (s: string) => s.length <= MM_MAX_CHARS && utf8Bytes(s) <= MM_MAX_BYTES;
  if (fits(message)) return [message];

  const chunks: string[] = [];
  let current = "";
  for (const line of message.split("\n")) {
    // A single oversized line gets hard-sliced (slice respects code units;
    // the byte check below keeps multibyte-heavy slices under the ceiling).
    const pieces: string[] = [];
    let rest = line;
    while (!fits(rest)) {
      let cut = Math.min(rest.length, MM_MAX_CHARS);
      while (cut > 1 && !fits(rest.slice(0, cut))) cut = Math.floor(cut / 2);
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    pieces.push(rest);

    for (const piece of pieces) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (current && !fits(candidate)) {
        chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { advisory_doc, mattermost_url, mattermost_channel_id, mattermost_bot_token, ...payload } = input;
    const doc = (advisory_doc ?? {}) as AdvisoryDoc;

    // Token/URL pairing rule: the env token may ONLY travel to the env URL.
    // A pipeline-controlled mattermost_url combined with the env token would
    // let untrusted input redirect MATTERMOST_BOT_TOKEN to an attacker host
    // (sage PR #40 blocker). Input URL therefore requires an input token.
    const inputUrl = mattermost_url as string | undefined;
    const inputToken = mattermost_bot_token as string | undefined;
    const url = inputUrl ?? process.env.MATTERMOST_URL;
    const channelId = (mattermost_channel_id as string | undefined) ?? process.env.MATTERMOST_CHANNEL_ID;
    const token = inputUrl ? inputToken : (inputToken ?? process.env.MATTERMOST_BOT_TOKEN);

    if (!url || !channelId || !token) {
      const missing = [
        !url && "MATTERMOST_URL",
        !channelId && "MATTERMOST_CHANNEL_ID",
        !token && "MATTERMOST_BOT_TOKEN",
      ].filter(Boolean);
      console.log(`📭 [A_NOTIFY_MATTERMOST] not configured (missing: ${missing.join(", ")}) — skipping`);
      return { ...payload, advisory_doc, mattermost: { skipped: true, missing } };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_NOTIFY_MATTERMOST requires the 'fetch' capability");

    const apiUrl = `${url.replace(/\/$/, "")}/api/v4/posts`;
    const chunks = splitMessage(sanitize(doc.markdown ?? "(no advisory document)"));

    // First chunk is the root post; the rest reply into its thread so a long
    // advisory stays one conversation in the channel, not a wall of posts.
    let rootId: string | undefined;
    for (const [i, message] of chunks.entries()) {
      const res = await fetchFn(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel_id: channelId,
          message,
          ...(rootId ? { root_id: rootId } : {}),
        }),
      });

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        throw new Error(`Mattermost post failed (chunk ${i + 1}/${chunks.length}): HTTP ${res.status} — ${detail}`);
      }

      const post = (await res.json()) as { id?: string; channel_id?: string; create_at?: number };
      if (!rootId) rootId = post.id;
    }

    console.log(
      `📬 [A_NOTIFY_MATTERMOST] posted advisory to channel ${channelId} (root post ${rootId ?? "?"}${chunks.length > 1 ? `, ${chunks.length - 1} thread repl${chunks.length === 2 ? "y" : "ies"}` : ""})`,
    );

    return {
      ...payload,
      advisory_doc,
      mattermost: { skipped: false, post_id: rootId, channel_id: channelId, chunk_count: chunks.length },
    };
  },
};
