/**
 * Normalise a collected agent value for a deterministic consumer.
 *
 * An `agent:` step's `collect` field holds the agent's RESULT VALUE (see
 * primitive-runner.ts) — which a real fleet agent may emit either as a
 * structured object or as a JSON string. A downstream D-node that needs the
 * structured shape tolerates both: parse a string, pass an object through.
 *
 * Returns undefined for null/undefined or unparseable input rather than
 * throwing. This is NOT itself a safe default — it just avoids a crash. Each
 * caller decides what undefined means; a fail-closed consumer (e.g.
 * A_DISPOSITION) must treat undefined as "not cleared", never as approval.
 *
 * DECODE-ONLY: this does NOT validate shape. The `<T>` is an UNCHECKED
 * assertion for caller ergonomics — a string is JSON-decoded, an object is
 * passed through as-is. The caller is responsible for verifying the fields it
 * reads (A_DISPOSITION/A_MERGE_PRECHECK use optional chaining + defaults).
 */
export function parseCollectedValue<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch (_err) {
      // Not JSON — the agent emitted a bare string where this consumer
      // expected structure; treat as "no usable value" (conservative).
      return undefined;
    }
  }
  return value as T;
}
