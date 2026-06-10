/**
 * Verdict tribunal — the pure decision core.
 *
 * Vote parsing, fail-closed aggregation, and the model-diversity rule as
 * total functions: no I/O, no providers, no clock. Dispatching seats and
 * emitting events is the primitive runner's job (primitive-runner.ts).
 *
 * Aggregation uses worst-case abstain interpretation: an abstain is an
 * absent signal, so it counts AGAINST an `allow` ruling (the hidden vote
 * could have been a deny) but never TOWARD a `deny` ruling (it is not an
 * affirmative refusal). The full table lives in docs/verdict-tribunal.md.
 *
 *   allows == denies                       → tie (runner convenes tiebreaker)
 *   abstains ≥ allows + denies             → deny  (incapacitated panel)
 *   denies > allows                        → deny
 *   allows > denies, allows ≤ denies+abst. → defer (hidden votes could flip)
 *   allows > denies + abstains, conf < bar → defer
 *   allows > denies + abstains, conf ≥ bar → allow
 *
 * Precedence note: the tie row is checked AFTER the incapacitated-panel row,
 * so a 1-1-3 panel denies rather than convening a tiebreaker.
 */

import type {
  SeatSpec,
  SeatVote,
  SeatVerdict,
  TribunalDiversity,
  TribunalRuling,
} from "../types/tribunal";

const VALID_SEAT_VERDICTS = new Set<SeatVerdict>(["allow", "deny", "abstain"]);

// ---------------------------------------------------------------------------
// Vote parsing — fail-closed, never throws
// ---------------------------------------------------------------------------

/** Build the fail-closed abstain vote a seat falls back to. */
export function abstainVote(seat: string, cause: string, model?: string): SeatVote {
  return { seat, verdict: "abstain", confidence: 0, reason: "", model, abstain_cause: cause };
}

/** Clamp confidence into [0, 1]; anything non-numeric collapses to 0. */
function coerceConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Extract a candidate vote object from arbitrary agent output: a structured
 * object, a JSON string, or prose containing a fenced ```json block / a bare
 * JSON object. Returns null when nothing parseable is found.
 */
function extractCandidate(output: unknown): Record<string, unknown> | null {
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  if (typeof output !== "string") return null;

  const attempts: string[] = [output];
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1]);
  const brace = output.match(/\{[\s\S]*\}/);
  if (brace) attempts.push(brace[0]);

  for (const text of attempts) {
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (_err) {
      // Not JSON — try the next extraction strategy; fail-closed abstain below.
    }
  }
  return null;
}

/**
 * Parse a seat's raw output into a SeatVote. Total: malformed, missing, or
 * unrecognizable output coerces to an abstain with a recorded cause — a seat
 * that cannot answer in form must never be read as an allow.
 */
export function parseSeatVote(seat: string, output: unknown, model?: string): SeatVote {
  const candidate = extractCandidate(output);
  if (!candidate) return abstainVote(seat, "unparseable seat output", model);

  const rawVerdict = candidate.verdict;
  if (typeof rawVerdict !== "string" || !VALID_SEAT_VERDICTS.has(rawVerdict as SeatVerdict)) {
    return abstainVote(seat, `invalid verdict ${JSON.stringify(rawVerdict ?? null)}`, model);
  }

  return {
    seat,
    verdict: rawVerdict as SeatVerdict,
    confidence: coerceConfidence(candidate.confidence),
    reason: typeof candidate.reason === "string" ? candidate.reason : "",
    model,
  };
}

// ---------------------------------------------------------------------------
// Aggregation — fail-closed, total
// ---------------------------------------------------------------------------

/** Internal aggregation outcome: a ruling, or a tie the runner must break. */
export interface AggregateResult {
  outcome: TribunalRuling | "tie";
  reason: string;
}

export function aggregate(votes: SeatVote[], confidenceBar: number = 0): AggregateResult {
  if (votes.length === 0) {
    return { outcome: "deny", reason: "empty panel — failing closed" };
  }

  const allows = votes.filter((v) => v.verdict === "allow");
  const denies = votes.filter((v) => v.verdict === "deny");
  const abstains = votes.filter((v) => v.verdict === "abstain");
  const tally = `${allows.length} allow / ${denies.length} deny / ${abstains.length} abstain`;

  if (abstains.length >= allows.length + denies.length) {
    return { outcome: "deny", reason: `incapacitated panel (${tally}) — abstaining panel denies` };
  }
  if (allows.length === denies.length) {
    return { outcome: "tie", reason: `split panel (${tally})` };
  }
  if (denies.length > allows.length) {
    return { outcome: "deny", reason: `majority deny (${tally})` };
  }
  // allows > denies from here on.
  if (allows.length <= denies.length + abstains.length) {
    return {
      outcome: "defer",
      reason: `non-robust allow majority (${tally}) — hidden abstain votes could flip the ruling`,
    };
  }
  const meanConfidence = allows.reduce((sum, v) => sum + v.confidence, 0) / allows.length;
  if (meanConfidence < confidenceBar) {
    return {
      outcome: "defer",
      reason: `allow majority (${tally}) below confidence bar (${meanConfidence.toFixed(2)} < ${confidenceBar})`,
    };
  }
  return {
    outcome: "allow",
    reason: `robust allow majority (${tally}), confidence ${meanConfidence.toFixed(2)} ≥ ${confidenceBar}`,
  };
}

// ---------------------------------------------------------------------------
// Model diversity — RavenClaude Gate 22, sovereignty-bounded
// ---------------------------------------------------------------------------

/** A seat's declared class; absent means unconstrained. */
function declaredClass(seat: SeatSpec): string {
  return seat.sovereignty?.model_class ?? "any";
}

export interface DiversityPlan {
  /** Seats to dispatch — reassigned copy when the panel was a monoculture. */
  seats: SeatSpec[];
  diversity: TribunalDiversity;
}

/**
 * Enforce declared-class diversity on panels of ≥2 seats. A monoculture
 * panel has one seat reassigned in the RESTRICTIVE direction only
 * (frontier/any → local-only). An all-local-only monoculture cannot be
 * loosened — sovereignty outranks diversity — so it proceeds unreassigned
 * and is marked unsatisfiable; the aggregator downgrades allow → defer.
 *
 * The LAST seat is the one reassigned, so the panel's primary lenses keep
 * their authored classes. Deterministic by construction.
 */
export function planDiversity(seats: SeatSpec[]): DiversityPlan {
  const classes = seats.map(declaredClass);
  const distinct = new Set(classes);

  if (seats.length < 2 || distinct.size >= 2) {
    return { seats, diversity: { classes } };
  }

  const monocultureClass = classes[0];
  if (monocultureClass === "local-only") {
    return { seats, diversity: { classes, unsatisfiable: true } };
  }

  const reassignIndex = seats.length - 1;
  const reassigned = seats.map((seat, i) =>
    i === reassignIndex
      ? {
          ...seat,
          sovereignty: { ...seat.sovereignty, model_class: "local-only" as const, frontier_ok: false },
        }
      : seat,
  );
  return {
    seats: reassigned,
    diversity: {
      classes: reassigned.map(declaredClass),
      reassigned_seat: seats[reassignIndex].name,
    },
  };
}

/**
 * Post-hoc executing-model check: declared classes can lie about backbones,
 * so when ≥2 seats report the identical model string the panel was a
 * monoculture in fact. Mutates nothing — returns the updated diversity record.
 */
export function checkPosthocDiversity(
  votes: SeatVote[],
  diversity: TribunalDiversity,
): TribunalDiversity {
  const models = votes.map((v) => v.model).filter((m): m is string => typeof m === "string" && m.length > 0);
  const duplicates = models.length !== new Set(models).size;
  return duplicates ? { ...diversity, posthoc_monoculture: true } : diversity;
}

/**
 * Downgrade an `allow` ruling to `defer` when diversity was unsatisfiable
 * (sovereignty-locked monoculture) or violated in fact (post-hoc duplicate
 * models). Where machine diversity is unattainable, a human compensates.
 */
export function applyDiversityDowngrade(
  result: { outcome: TribunalRuling; reason: string },
  diversity: TribunalDiversity,
): { outcome: TribunalRuling; reason: string } {
  if (result.outcome !== "allow") return result;
  if (diversity.unsatisfiable) {
    return {
      outcome: "defer",
      reason: `${result.reason}; downgraded — all-local-only panel, diversity unsatisfiable under sovereignty`,
    };
  }
  if (diversity.posthoc_monoculture) {
    return {
      outcome: "defer",
      reason: `${result.reason}; downgraded — seats reported identical executing models`,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Vote-format contract appended to every seat prompt
// ---------------------------------------------------------------------------

export const VOTE_FORMAT_INSTRUCTION = `

Respond with ONLY a JSON object in this exact shape:
{"verdict": "allow" | "deny" | "abstain", "confidence": <number 0..1>, "reason": "<one line>"}`;
