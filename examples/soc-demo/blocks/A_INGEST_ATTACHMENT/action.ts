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
  /** Base64 file bytes, inlined by the surface adapter (Mattermost needs auth
   *  to download, so the brain can't fetch the URL). When present it is decoded
   *  directly — no network fetch. */
  content?: string;
}

/** Decode quoted-printable (RFC 2045): =XX hex octets + soft line breaks (=\n). */
function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "") // soft line break
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** True for an .eml / RFC822 message by content-type or extension. */
function isEml(att: Attachment): boolean {
  const ct = (att.contentType ?? "").toLowerCase();
  return ct === "message/rfc822" || (att.name ?? "").toLowerCase().endsWith(".eml");
}

/**
 * Parse a raw RFC822 .eml into IOC-rich plaintext: the key headers (sender /
 * routing / subject — where the attacker's domains live in the clear) plus each
 * text part DECODED from its Content-Transfer-Encoding (base64 / quoted-
 * printable), so URLs in the body survive for A_EXTRACT_IOCS. Best-effort and
 * tolerant: a part it can't parse is passed through raw rather than dropped.
 */
function decodeByCte(body: string, cte: string): string {
  try {
    if (cte === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    if (cte === "quoted-printable") return decodeQuotedPrintable(body);
  } catch {
    // decode failure must not drop the part — fall through to raw
  }
  return body;
}

function parseEml(raw: string): string {
  const sep = raw.search(/\r?\n\r?\n/);
  // No header/body separator → no MIME structure to decode; scan as-is so a
  // simple/odd .eml still yields its IOCs (lossless).
  if (sep === -1) return raw;

  // Keep ALL headers (unfolded) — losing any risks dropping an IOC-bearing one
  // (List-Unsubscribe, X-Originating-IP, DKIM d=, Received relays).
  const headers = raw.slice(0, sep).replace(/\r?\n[ \t]+/g, " ");
  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
  const bodies: string[] = [];

  if (boundaryMatch) {
    // Multipart: decode each part by its OWN Content-Transfer-Encoding.
    for (const part of raw.split(`--${boundaryMatch[1]}`).slice(1)) {
      if (/^--/.test(part.trim())) continue; // closing delimiter
      const cte = (part.match(/Content-Transfer-Encoding:\s*([^\r\n;]+)/i)?.[1] ?? "").trim().toLowerCase();
      const bsep = part.search(/\r?\n\r?\n/);
      bodies.push(decodeByCte(bsep === -1 ? part : part.slice(bsep), cte));
    }
  } else {
    // Single-part: CTE lives in the top headers; body is everything after sep.
    const cte = (headers.match(/Content-Transfer-Encoding:\s*([^\r\n;]+)/i)?.[1] ?? "").trim().toLowerCase();
    bodies.push(decodeByCte(raw.slice(sep), cte));
  }

  return [headers, ...bodies].filter((s) => s.trim().length > 0).join("\n\n");
}

/**
 * Size ceiling for a single attachment. Enforced PRIMARILY via the response
 * Content-Length (bytes) BEFORE decoding, so an oversized upload is rejected
 * without reading it into memory. A char-length slice is a best-effort fallback
 * only when the header is absent (then it bounds the folded string, not the
 * fetch).
 */
const MAX_DECODE_BYTES = 256 * 1024;

/** Max number of attachments processed in one message (overflow recorded, not fetched). */
const MAX_ATTACHMENTS = 10;
/** Max TOTAL decoded content folded into `text` across all attachments. */
const MAX_TOTAL_FOLDED_BYTES = 1024 * 1024;

/** Per-attachment fetch deadline. A URL that never responds must NOT hang the
 *  step (and, with a single-concurrency brain, the whole agent) — time out and
 *  record an error instead. */
const FETCH_TIMEOUT_MS = 15_000;

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

async function decodeAttachment(att: Attachment, fetchFn?: typeof globalThis.fetch): Promise<DecodeOutcome> {
  const label = att.name ?? att.url ?? "attachment";
  if (!isTextLike(att)) return { kind: "skipped", label: `${label} (${att.contentType ?? "binary"})` };

  let raw: string;
  if (typeof att.content === "string" && att.content.length > 0) {
    // Inline bytes (Mattermost, auth-fetched by the adapter) — decode, no fetch.
    try {
      raw = Buffer.from(att.content, "base64").toString("utf8");
    } catch (err) {
      return { kind: "error", label, error: `${label}: base64 decode failed — ${err instanceof Error ? err.message : String(err)}` };
    }
    if (raw.length > MAX_DECODE_BYTES) raw = raw.slice(0, MAX_DECODE_BYTES);
  } else if (att.url && fetchFn) {
    // Public-CDN URL (Discord) — fetch with a hard deadline (a stalled
    // connection must not hang the step / wedge the single-slot brain).
    try {
      const res = await fetchFn(att.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return { kind: "error", label, error: `${label}: HTTP ${res.status}` };
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_DECODE_BYTES) {
        return { kind: "error", label, error: `${label}: too large (${declared} bytes > ${MAX_DECODE_BYTES} cap)` };
      }
      raw = await res.text();
      if (raw.length > MAX_DECODE_BYTES) raw = raw.slice(0, MAX_DECODE_BYTES);
    } catch (err) {
      return { kind: "error", label, error: `${label}: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    return { kind: "skipped", label: `${label} (no inline content or fetchable url)` };
  }

  // A .eml is MIME — decode its parts so body URLs survive (raw base64/QP bodies
  // would otherwise extract nothing). Other text files fold verbatim.
  const part = isEml(att) ? parseEml(raw) : raw;
  return { kind: "decoded", label, part: `--- attachment: ${label} ---\n${part}` };
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    // NOTE: do NOT destructure `attachments` out of payload — it must pass
    // through unchanged (monotonic payload). Read it, leave it in place.
    const list = Array.isArray(input.attachments) ? (input.attachments as Attachment[]) : [];
    const baseText = typeof input.text === "string" ? input.text : "";

    const fetchFn = ctx.capabilities.fetch;
    if (list.length === 0) {
      // Nothing to ingest — pass everything through, ensuring a `text` field
      // exists for downstream readers.
      return {
        ...input,
        text: baseText,
        attachments_ingested: { decoded: 0, skipped: 0, errors: [] as string[] },
      };
    }
    // NB: fetchFn may be undefined — inline-content attachments (Mattermost)
    // decode without it; only URL attachments (Discord) need it.

    // Cap how many attachments we fetch in one message (overflow recorded, not
    // downloaded) so an unbounded array can't fan out unbounded fetches.
    const capped = list.slice(0, MAX_ATTACHMENTS);
    const skipped: string[] = list.length > MAX_ATTACHMENTS
      ? [`+${list.length - MAX_ATTACHMENTS} more (over ${MAX_ATTACHMENTS}-attachment cap)`]
      : [];

    // Fetch the capped set CONCURRENTLY, preserving input order when assembling
    // the folded text (Promise.all keeps array order).
    const outcomes = await Promise.all(capped.map((att) => decodeAttachment(att, fetchFn)));

    const decodedParts: string[] = [];
    const decodedNames: string[] = [];
    const errors: string[] = [];
    let foldedBytes = 0;
    for (const o of outcomes) {
      if (o.kind === "skipped") {
        skipped.push(o.label);
      } else if (o.kind === "error") {
        errors.push(o.error);
      } else if (foldedBytes + o.part.length > MAX_TOTAL_FOLDED_BYTES) {
        // Aggregate budget exhausted — record, don't fold (bounds total memory).
        skipped.push(`${o.label} (over ${MAX_TOTAL_FOLDED_BYTES}-byte total-fold budget)`);
      } else {
        decodedParts.push(o.part);
        decodedNames.push(o.label);
        foldedBytes += o.part.length;
      }
    }

    // Append any decoded content AFTER the pasted text. If every decode failed
    // or was skipped, `text` is just the original pasted text (baseText).
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
