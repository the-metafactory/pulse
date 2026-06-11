/**
 * A_OPEN_TICKET — RT / Jira ServiceDesk adapter (design/soc-demo-mm-composer.md §4).
 *
 * Stub-safe external adapter, same contract as A_FETCH_VIRUSTOTAL: env-checked
 * at execute time, deterministic synthetic response when the credentials are
 * missing. The demo must run offline — a missing key is a documented mode
 * ("logs intent, returns synthetic ticket id"), not an error. When both
 * TICKET_API_URL and TICKET_API_TOKEN are set, a real RT REST 2.0 ticket is
 * created and a failed call DOES fail the pipeline: a SOC that thinks it
 * opened a ticket but didn't is worse than a visible error.
 *
 * The synthetic id is derived from a hash of the subject, so the same subject
 * always yields the same DEMO- id (deterministic, demo-friendly).
 */

import type { ActionContext } from "../../../../src/types/action";

interface TicketResult {
  id: string;
  url: string | null;
  queue: string;
  source: "stub" | "rt";
}

/** Small stable string hash (FNV-1a, 32-bit) for deterministic synthetic ids. */
function hashSubject(subject: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < subject.length; i++) {
    h ^= subject.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned, base36, zero-padded to a stable width.
  return (h >>> 0).toString(36).toUpperCase().padStart(7, "0");
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { subject, body, queue, ...payload } = input;
    if (typeof subject !== "string" || subject.length === 0) {
      throw new Error("A_OPEN_TICKET: subject must be a non-empty string");
    }
    const queueName = typeof queue === "string" && queue.length > 0 ? queue : "SOC";
    const bodyText = typeof body === "string" ? body : "";

    const apiUrl = process.env.TICKET_API_URL;
    const apiToken = process.env.TICKET_API_TOKEN;
    if (!apiUrl || !apiToken) {
      const id = `DEMO-${hashSubject(subject)}`;
      console.log(
        `🎫 [A_OPEN_TICKET] stub mode (TICKET_API_URL/TICKET_API_TOKEN unset) — would open ticket "${subject}" in queue ${queueName} → ${id}`,
      );
      const ticket: TicketResult = { id, url: null, queue: queueName, source: "stub" };
      return { ...payload, ticket };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_OPEN_TICKET: fetch capability not injected");

    const endpoint = `${apiUrl.replace(/\/$/, "")}/REST/2.0/ticket`;
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: `token ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ Subject: subject, Content: bodyText, Queue: queueName }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new Error(`A_OPEN_TICKET: ticket API returned ${res.status} — ${detail}`);
    }
    const created = (await res.json()) as { id?: string | number };
    const id = String(created.id ?? "");
    if (!id) throw new Error("A_OPEN_TICKET: ticket API response missing id");

    const ticket: TicketResult = {
      id,
      url: `${apiUrl.replace(/\/$/, "")}/Ticket/Display.html?id=${id}`,
      queue: queueName,
      source: "rt",
    };
    return { ...payload, ticket };
  },
};
