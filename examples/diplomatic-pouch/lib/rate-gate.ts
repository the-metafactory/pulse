/**
 * Rate gate — the token-economy guard (Foreign Policy §4), built from the
 * Sumarhús RATE-GATE.md blueprint. From spec, not code: the blueprint ships
 * the algorithm and explicitly says "build your own guard from it."
 *
 * Blueprint invariants kept verbatim:
 *   - Deterministic time: `now` is ALWAYS a parameter — the guard never reads
 *     the wall clock. Same inputs, same decision, testable forever.
 *   - `check` never mutates; `record` returns a NEW ledger (append).
 *   - Fail-closed on the economy too: unreadable state, malformed entries,
 *     or unparseable timestamps BLOCK — silence is cheaper than spamming a
 *     peer who pays for the tokens.
 *
 * Enforces: ≤3 messages per rolling 24h per peer · dedupe by sha256 · one
 * open thread per topic (a new topic is a human-approval trigger, never an
 * auto-send).
 */

export interface LedgerEntry {
  ts: string; // ISO-8601 — when the message was actually sent
  sha256: string;
  topic: string;
}

export interface RateDecision {
  allowed: boolean;
  reason: string;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_WINDOW = 3;

function parseTs(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** Validate the ledger shape. ANY malformed entry poisons the whole ledger —
 *  fail closed; a guard that can't read its state must not wave through. */
function validLedger(ledger: unknown): ledger is LedgerEntry[] {
  if (!Array.isArray(ledger)) return false;
  return ledger.every(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      parseTs((e as LedgerEntry).ts) !== null &&
      typeof (e as LedgerEntry).sha256 === "string" &&
      (e as LedgerEntry).sha256.length > 0 &&
      typeof (e as LedgerEntry).topic === "string",
  );
}

/**
 * May this note be sent now? Pure — never mutates the ledger.
 *
 * Blueprint §check: dedupe by hash → rolling 24h count → topic discipline.
 */
export function check(
  ledger: unknown,
  noteSha256: string,
  topic: string,
  now: string,
): RateDecision {
  const nowMs = parseTs(now);
  if (nowMs === null) {
    return { allowed: false, reason: "fail-closed: 'now' is not a valid ISO-8601 timestamp" };
  }
  if (!validLedger(ledger)) {
    return { allowed: false, reason: "fail-closed: ledger unreadable or malformed — blocking, not sending" };
  }
  if (typeof noteSha256 !== "string" || noteSha256.length !== 64) {
    return { allowed: false, reason: "fail-closed: note hash missing or malformed" };
  }

  if (ledger.some((e) => e.sha256 === noteSha256)) {
    return { allowed: false, reason: "duplicate: identical content (by sha256) was already sent" };
  }

  const recent = ledger.filter((e) => {
    const t = parseTs(e.ts);
    return t !== null && nowMs - t < WINDOW_MS && t <= nowMs;
  });
  if (recent.length >= MAX_PER_WINDOW) {
    return {
      allowed: false,
      reason: `rate limit: ${MAX_PER_WINDOW}/24h reached for this peer — queue, don't send`,
    };
  }

  // One open thread per topic: sending on a topic this ledger has never seen
  // is a NEW thread — a human-approval trigger (Foreign Policy §3), surfaced
  // as a distinct reason so the pipeline routes it to the gate loudly.
  const knownTopic = ledger.some((e) => e.topic === topic);
  if (!knownTopic && ledger.length > 0) {
    return {
      allowed: true,
      reason: `NEW TOPIC '${topic}' — requires explicit named-human approval (first thread on this topic)`,
    };
  }
  if (ledger.length === 0) {
    return {
      allowed: true,
      reason: `FIRST CONTACT — establishing relations is a human act; named-human approval required`,
    };
  }

  return { allowed: true, reason: `within quota (${recent.length}/${MAX_PER_WINDOW} in window), known topic` };
}

/** Append a sent message. Returns a NEW ledger — call only after the human
 *  approved AND the send happened (blueprint: record never gates). */
export function record(
  ledger: LedgerEntry[],
  noteSha256: string,
  topic: string,
  now: string,
): LedgerEntry[] {
  return [...ledger, { ts: now, sha256: noteSha256, topic }];
}

/** Remaining quota in the rolling window at `now`. */
export function status(ledger: unknown, now: string): { remaining: number } {
  const nowMs = parseTs(now);
  if (nowMs === null || !validLedger(ledger)) return { remaining: 0 }; // fail closed
  const recent = ledger.filter((e) => {
    const t = parseTs(e.ts);
    return t !== null && nowMs - t < WINDOW_MS && t <= nowMs;
  });
  return { remaining: Math.max(0, MAX_PER_WINDOW - recent.length) };
}
