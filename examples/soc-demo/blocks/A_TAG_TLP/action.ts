/**
 * A_TAG_TLP — assign a TLP 2.0 marking by deterministic keyword heuristic.
 *
 * D-class block for the SOC demo palette (design/soc-demo-mm-composer.md §4):
 * FIRST/TI-aware audiences expect content to carry a Traffic Light Protocol
 * marking. No env, no network, no capabilities — pure and offline.
 *
 * IMPORTANT: this is a DEMO heuristic, not a sharing policy. Real TLP
 * assignment is a human/governance decision; here we map a few keyword classes
 * to markings so a flow can show the mechanism. Precedence is most-restrictive
 * first: active-incident language → RED, then personal-data/credential
 * mentions → AMBER, then internal-community language → GREEN, otherwise the
 * caller's default_tlp (if a valid marking) or TLP:CLEAR.
 */

import type { ActionContext } from "../../../../src/types/action";

type Marking = "TLP:CLEAR" | "TLP:GREEN" | "TLP:AMBER" | "TLP:RED";

interface TlpResult {
  marking: Marking;
  reason: string;
}

const VALID_MARKINGS: readonly Marking[] = ["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:RED"];

// Most-restrictive first; first matching band wins.
const RED_RE = /\b(ongoing|active incident|do not share)\b/i;
const AMBER_RE = /\b(password|credential|credentials|victim|personal data|pii)\b/i;
const GREEN_RE = /\b(member|members|constituency|internal)\b/i;

function normalizeDefault(value: unknown): Marking {
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase().replace(/\s+/g, "");
    const candidate = upper.startsWith("TLP:") ? upper : `TLP:${upper}`;
    if ((VALID_MARKINGS as readonly string[]).includes(candidate)) return candidate as Marking;
  }
  return "TLP:CLEAR";
}

export default {
  async execute(input: Record<string, unknown>, _ctx: ActionContext) {
    const { text, default_tlp, ...payload } = input;
    if (typeof text !== "string") {
      throw new Error("A_TAG_TLP: text must be a string");
    }

    let tlp: TlpResult;
    if (RED_RE.test(text)) {
      tlp = { marking: "TLP:RED", reason: "active-incident language detected (ongoing / do not share)" };
    } else if (AMBER_RE.test(text)) {
      tlp = { marking: "TLP:AMBER", reason: "personal data or credentials referenced" };
    } else if (GREEN_RE.test(text)) {
      tlp = { marking: "TLP:GREEN", reason: "internal community / constituency language detected" };
    } else {
      const fallback = normalizeDefault(default_tlp);
      tlp = { marking: fallback, reason: `no marking keywords matched; using ${default_tlp ? "default_tlp" : "TLP:CLEAR"}` };
    }

    return { ...payload, tlp };
  },
};
