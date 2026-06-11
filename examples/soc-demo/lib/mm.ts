/**
 * Minimal Mattermost thread client for the SOC demo wiring (P-805).
 *
 * Stub-safe like every demo adapter: when MATTERMOST_URL / MATTERMOST_BOT_TOKEN
 * / MATTERMOST_CHANNEL_ID are unset, the wiring uses ConsolePoster instead and
 * the demo runs fully offline. The env token never travels anywhere but the
 * env URL (no caller-supplied URL path exists here at all).
 *
 * Intentionally tiny: createPost + file upload + thread polling. The cortex
 * stack owns the bot identity and channel config (design §6 — JC provisions;
 * this code only consumes env).
 */

import type { GateInput, GateProvider } from "../../../src/types/pipeline";

export interface MMConfig {
  url: string;
  token: string;
  channelId: string;
}

export function mmConfigFromEnv(): MMConfig | null {
  const url = process.env.MATTERMOST_URL;
  const token = process.env.MATTERMOST_BOT_TOKEN;
  const channelId = process.env.MATTERMOST_CHANNEL_ID;
  if (!url || !token || !channelId) return null;
  return { url: url.replace(/\/$/, ""), token, channelId };
}

export interface ThreadPoster {
  /** Post into the thread (first call creates the root). Returns post id. */
  post(message: string, file?: { bytes: Uint8Array; filename: string }): Promise<string>;
}

/** Offline poster — prints what would be posted. The stub-safe default. */
export class ConsolePoster implements ThreadPoster {
  public readonly posts: string[] = [];
  private counter = 0;

  async post(message: string, file?: { bytes: Uint8Array; filename: string }): Promise<string> {
    this.posts.push(message);
    console.log(`\n💬 [thread] ${message}${file ? `\n📎 [attachment] ${file.filename} (${file.bytes.byteLength} bytes)` : ""}`);
    return `console-${++this.counter}`;
  }
}

export class MattermostThread implements ThreadPoster {
  private rootId: string | undefined;
  private lastSeen = 0;

  constructor(
    private readonly cfg: MMConfig,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" };
  }

  async post(message: string, file?: { bytes: Uint8Array; filename: string }): Promise<string> {
    let fileIds: string[] = [];
    if (file) {
      const form = new FormData();
      form.append("files", new Blob([file.bytes as BlobPart], { type: "image/png" }), file.filename);
      form.append("channel_id", this.cfg.channelId);
      const up = await this.fetchFn(`${this.cfg.url}/api/v4/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.token}` },
        body: form,
      });
      if (up.ok) {
        const body = (await up.json()) as { file_infos?: Array<{ id: string }> };
        fileIds = (body.file_infos ?? []).map((f) => f.id);
      } else {
        console.error(`[mm] file upload failed (${up.status}) — posting without attachment`);
      }
    }

    const res = await this.fetchFn(`${this.cfg.url}/api/v4/posts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        channel_id: this.cfg.channelId,
        message,
        ...(this.rootId ? { root_id: this.rootId } : {}),
        ...(fileIds.length ? { file_ids: fileIds } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Mattermost post failed: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    }
    const post = (await res.json()) as { id: string; create_at?: number };
    if (!this.rootId) this.rootId = post.id;
    this.lastSeen = post.create_at ?? Date.now();
    return post.id;
  }

  /**
   * Poll the thread for a reply (from anyone but the bot's own posts we made)
   * whose text matches. Resolves with the matching message text.
   */
  async waitForReply(matcher: RegExp, opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    if (!this.rootId) throw new Error("waitForReply: no thread root yet");
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const pollMs = opts.pollMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error("waitForReply: aborted");
      const res = await this.fetchFn(`${this.cfg.url}/api/v4/posts/${this.rootId}/thread`, {
        headers: this.headers(),
      });
      if (res.ok) {
        const body = (await res.json()) as { posts?: Record<string, { message: string; create_at: number }> };
        const candidates = Object.values(body.posts ?? {})
          .filter((p) => p.create_at > this.lastSeen)
          .sort((a, b) => a.create_at - b.create_at);
        for (const p of candidates) {
          if (matcher.test(p.message)) {
            this.lastSeen = p.create_at;
            return p.message;
          }
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`waitForReply: no matching reply within ${timeoutMs}ms`);
  }
}

/** Parse an operator ack reply into a gate verdict. Exported for tests. */
export function parseAckReply(text: string): GateInput | null {
  if (/\b(run it|run|approve|go|ship it|lgtm)\b/i.test(text)) return { verdict: "pass", notes: text };
  if (/\b(stop|abort|reject|no)\b/i.test(text)) return { verdict: "fail", notes: text };
  return null;
}

/**
 * GateProvider that opens the operator-ack gate as a Mattermost thread reply
 * (design §5: JC acks "run it"). Used for the composer ack AND any gate:
 * steps inside the composed flow.
 */
export class MMAckGateProvider implements GateProvider {
  constructor(private readonly thread: MattermostThread) {}

  async requestVerdict(spec: { name: string; prompt: string; signal?: AbortSignal }): Promise<GateInput> {
    await this.thread.post(`🚧 **Gate \`${spec.name}\`** — ${spec.prompt}\n_Reply "run it" / "approve" to continue, "stop" to abort._`);
    // Poll until a reply parses to a verdict.
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const reply = await this.thread.waitForReply(/run it|run|approve|go|ship it|lgtm|stop|abort|reject|\bno\b/i, {
        timeoutMs: deadline - Date.now(),
        signal: spec.signal,
      });
      const verdict = parseAckReply(reply);
      if (verdict) return verdict;
    }
    throw new Error(`gate ${spec.name}: no operator verdict`);
  }
}
