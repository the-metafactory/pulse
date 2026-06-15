/**
 * A_INGEST_ATTACHMENT — fold chat file uploads into the flow's `text`.
 *
 * A Discord/Mattermost @-mention can carry file attachments (a phishing .eml,
 * a .txt/.csv of IOCs). When the host passes them in as an `attachments` array
 * of { name, contentType, url } (the cortex brain-task hop is a SEPARATE
 * change), this block FETCHES each text-like attachment and appends its decoded
 * content to `text`, so the rest of the flow (A_EXTRACT_IOCS refang/extract,
 * the triage agent) treats a dropped file exactly like pasted text — no new
 * downstream contract.
 *
 * Scope (deliberate, demo): only TEXT-like types are decoded (text/*,
 * message/rfc822, application/json, and .eml/.txt/.csv/.log/.json/.md/.ics by
 * extension). A .eml is appended raw — headers + body + URLs are all text, so
 * A_EXTRACT_IOCS picks the IOCs straight out of it; a dedicated MIME parser is
 * a follow-up. Binary / image attachments are NOT decoded (no OCR) — recorded
 * in `attachments_ingested` as metadata so a flow can see they arrived.
 *
 * Passthrough: the original `attachments` field is returned UNCHANGED alongside
 * the new `text` + `attachments_ingested` (payload grows monotonically).
 *
 * Requires the `fetch` capability (manifest `requires: ["fetch"]`). Fail-soft:
 * no attachments → pass through unchanged; a per-attachment fetch/decode error
 * (incl. an oversized file rejected by Content-Length) is recorded in
 * `attachments_ingested.errors`, never thrown — one bad upload must not crash
 * the flow. The `!fetchFn` branch below is defensive (a compliant host always
 * injects the required capability), not an advertised no-fetch contract.
 */

import type { ActionContext } from "../../../../src/types/action";

interface Attachment {
  name?: string;
  contentType?: string;
  url?: string;
  size?: number;
}

/**
 * Size ceiling for a single attachment. Enforced PRIMARILY via the response
 * Content-Length (bytes) BEFORE decoding, so an oversized upload is rejected
 * without reading it into memory. A char-length slice is a best-effort fallback
 * only when the header is absent (then it bounds the folded string, not the
 * fetch).
 */
const MAX_DECODE_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = [".eml", ".txt", ".csv", ".log", ".json", ".md", ".ics"];

function isTextLike(att: Attachment): boolean {
  const ct = (att.contentType ?? "").toLowerCase();
  if (ct.startsWith("text/") || ct === "message/rfc822" || ct === "application/json") return true;
  const name = (att.name ?? "").toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

type DecodeOutcome =
  | { kind: "decoded"; label: string; part: string }
  | { kind: "skipped"; label: string }
  | { kind: "error"; label: string; error: string };

async function decodeAttachment(att: Attachment, fetchFn: typeof globalThis.fetch): Promise<DecodeOutcome> {
  const label = att.name ?? att.url ?? "attachment";
  if (!att.url) return { kind: "skipped", label: `${label} (no url)` };
  if (!isTextLike(att)) return { kind: "skipped", label: `${label} (${att.contentType ?? "binary"})` };
  try {
    const res = await fetchFn(att.url);
    if (!res.ok) return { kind: "error", label, error: `${label}: HTTP ${res.status}` };
    // Byte cap via Content-Length BEFORE decoding — bound fetch/decode cost.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_DECODE_BYTES) {
      return { kind: "error", label, error: `${label}: too large (${declared} bytes > ${MAX_DECODE_BYTES} cap)` };
    }
    let body = await res.text();
    if (body.length > MAX_DECODE_BYTES) body = body.slice(0, MAX_DECODE_BYTES); // fallback bound (no header)
    return { kind: "decoded", label, part: `--- attachment: ${label} ---\n${body}` };
  } catch (err) {
    return { kind: "error", label, error: `${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    // NOTE: do NOT destructure `attachments` out of payload — it must pass
    // through unchanged (monotonic payload). Read it, leave it in place.
    const list = Array.isArray(input.attachments) ? (input.attachments as Attachment[]) : [];
    const baseText = typeof input.text === "string" ? input.text : "";

    const fetchFn = ctx.capabilities.fetch;
    if (list.length === 0 || !fetchFn) {
      // Nothing to ingest (or no fetch capability) — pass everything through,
      // ensuring a `text` field exists for downstream readers.
      return {
        ...input,
        text: baseText,
        attachments_ingested: { decoded: 0, skipped: list.length, errors: [] as string[] },
      };
    }

    // Fetch all text-like attachments CONCURRENTLY, preserving input order when
    // assembling the folded text (Promise.all keeps array order).
    const outcomes = await Promise.all(list.map((att) => decodeAttachment(att, fetchFn)));

    const decodedParts: string[] = [];
    const decodedNames: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    for (const o of outcomes) {
      if (o.kind === "decoded") {
        decodedParts.push(o.part);
        decodedNames.push(o.label);
      } else if (o.kind === "skipped") {
        skipped.push(o.label);
      } else {
        errors.push(o.error);
      }
    }

    // Append decoded content AFTER any pasted text, so both reach A_EXTRACT_IOCS.
    const text = decodedParts.length > 0 ? [baseText, ...decodedParts].filter(Boolean).join("\n\n") : baseText;

    return {
      ...input,
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
