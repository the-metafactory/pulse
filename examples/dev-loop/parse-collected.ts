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
