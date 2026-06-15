/**
 * A_INGEST_ATTACHMENT — fold chat file uploads into the flow's `text`.
 *
 * A Discord/Mattermost @-mention can carry file attachments (a phishing .eml,
 * a .txt/.csv of IOCs). cortex passes them through the brain task as an
 * `attachments` array of { name, contentType, url }. This block FETCHES each
 * text-like attachment and appends its decoded content to `text`, so the rest
 * of the flow (A_EXTRACT_IOCS refang/extract, the triage agent) treats a
 * dropped file exactly like pasted text — no new downstream contract.
 *
 * Scope (deliberate, demo): only TEXT-like types are decoded (text/*,
 * message/rfc822, and .eml/.txt/.csv/.log/.json/.eml by extension). A .eml is
 * appended raw — headers + body + URLs are all text, so A_EXTRACT_IOCS picks
 * the IOCs straight out of it; a dedicated MIME parser is a follow-up. Binary
 * / image attachments are NOT decoded (no OCR) — they're recorded in
 * `attachments_ingested` as metadata so a flow can see they arrived.
 *
 * Stub-safe & fail-soft: no attachments, or no `fetch` capability → pass
 * through unchanged. A per-attachment fetch/decode error is recorded in
 * `attachments_ingested.errors`, never thrown — one bad upload must not crash
 * the flow.
 */

import type { ActionContext } from "../../../../src/types/action";

interface Attachment {
  name?: string;
  contentType?: string;
  url?: string;
  size?: number;
}

/** Max bytes we will fold into `text` from a single attachment (demo cap). */
const MAX_DECODE_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = [".eml", ".txt", ".csv", ".log", ".json", ".md", ".ics"];

function isTextLike(att: Attachment): boolean {
  const ct = (att.contentType ?? "").toLowerCase();
  if (ct.startsWith("text/") || ct === "message/rfc822" || ct === "application/json") return true;
  const name = (att.name ?? "").toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { attachments, ...payload } = input;
    const list = Array.isArray(attachments) ? (attachments as Attachment[]) : [];
    const baseText = typeof payload.text === "string" ? payload.text : "";

    const fetchFn = ctx.capabilities.fetch;
    if (list.length === 0 || !fetchFn) {
      // Nothing to ingest (or no fetch capability) — pass through untouched.
      return {
        ...payload,
        ...(typeof payload.text === "string" ? {} : { text: baseText }),
        attachments_ingested: { decoded: 0, skipped: list.length, errors: [] as string[] },
      };
    }

    const decodedParts: string[] = [];
    const decodedNames: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const att of list) {
      const label = att.name ?? att.url ?? "attachment";
      if (!att.url) {
        skipped.push(`${label} (no url)`);
        continue;
      }
      if (!isTextLike(att)) {
        skipped.push(`${label} (${att.contentType ?? "binary"})`);
        continue;
      }
      try {
        const res = await fetchFn(att.url);
        if (!res.ok) {
          errors.push(`${label}: HTTP ${res.status}`);
          continue;
        }
        let body = await res.text();
        if (body.length > MAX_DECODE_BYTES) body = body.slice(0, MAX_DECODE_BYTES);
        decodedParts.push(`--- attachment: ${label} ---\n${body}`);
        decodedNames.push(label);
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Append decoded content AFTER any pasted text, so both reach A_EXTRACT_IOCS.
    const text = decodedParts.length > 0 ? [baseText, ...decodedParts].filter(Boolean).join("\n\n") : baseText;

    return {
      ...payload,
      text,
      attachments_ingested: {
        decoded: decodedNames.length,
        names: decodedNames,
        skipped: skipped.length,
        skipped_detail: skipped,
        errors,
      },
    };
  },
};
