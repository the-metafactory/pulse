/**
 * Tribunal pure core tests — vote parsing, fail-closed aggregation table,
 * and the model-diversity rule. No providers, no runner: total functions only.
 */

import { describe, test, expect } from "bun:test";
import {
  abstainVote,
  aggregate,
  applyDiversityDowngrade,
  checkPosthocDiversity,
  parseSeatVote,
  planDiversity,
} from "../src/lib/tribunal";
import type { SeatSpec, SeatVote } from "../src/types/tribunal";

function vote(verdict: "allow" | "deny" | "abstain", confidence = 1, seat = "s"): SeatVote {
  return { seat, verdict, confidence, reason: "" };
}

describe("parseSeatVote", () => {
  test("parses a structured object output", () => {
    const v = parseSeatVote("sec", { verdict: "allow", confidence: 0.9, reason: "clean" }, "m1");
    expect(v).toEqual({ seat: "sec", verdict: "allow", confidence: 0.9, reason: "clean", model: "m1" });
  });

  test("parses a JSON string output", () => {
    const v = parseSeatVote("sec", '{"verdict": "deny", "confidence": 0.8, "reason": "injection"}');
    expect(v.verdict).toBe("deny");
    expect(v.confidence).toBe(0.8);
  });

  test("extracts a fenced ```json block from prose", () => {
    const output = 'My analysis follows.\n```json\n{"verdict": "allow", "confidence": 0.7, "reason": "ok"}\n```\nDone.';
    const v = parseSeatVote("sec", output);
    expect(v.verdict).toBe("allow");
    expect(v.confidence).toBe(0.7);
  });

  test("extracts a bare JSON object embedded in prose", () => {
    const v = parseSeatVote("sec", 'Verdict: {"verdict": "deny", "confidence": 1, "reason": "bad"} end');
    expect(v.verdict).toBe("deny");
  });

  test("unparseable output coerces to abstain, never throws", () => {
    const v = parseSeatVote("sec", "I think it looks fine to me");
    expect(v.verdict).toBe("abstain");
    expect(v.confidence).toBe(0);
    expect(v.abstain_cause).toMatch(/unparseable/);
  });

  test("invalid verdict value coerces to abstain", () => {
    const v = parseSeatVote("sec", { verdict: "approve", confidence: 1 });
    expect(v.verdict).toBe("abstain");
    expect(v.abstain_cause).toMatch(/invalid verdict/);
  });

  test("null and array outputs coerce to abstain", () => {
    expect(parseSeatVote("s", null).verdict).toBe("abstain");
    expect(parseSeatVote("s", [1, 2]).verdict).toBe("abstain");
    expect(parseSeatVote("s", undefined).verdict).toBe("abstain");
  });

  test("confidence clamps to [0,1]; non-numeric collapses to 0", () => {
    expect(parseSeatVote("s", { verdict: "allow", confidence: 1.5 }).confidence).toBe(1);
    expect(parseSeatVote("s", { verdict: "allow", confidence: -0.3 }).confidence).toBe(0);
    expect(parseSeatVote("s", { verdict: "allow", confidence: "high" }).confidence).toBe(0);
    expect(parseSeatVote("s", { verdict: "allow", confidence: NaN }).confidence).toBe(0);
    expect(parseSeatVote("s", { verdict: "allow" }).confidence).toBe(0);
  });

  test("non-string reason collapses to empty string", () => {
    expect(parseSeatVote("s", { verdict: "allow", confidence: 1, reason: 42 }).reason).toBe("");
  });
});

describe("aggregate — fail-closed table", () => {
  test("empty panel denies", () => {
    expect(aggregate([]).outcome).toBe("deny");
  });

  test("all-abstain panel denies", () => {
    const r = aggregate([vote("abstain"), vote("abstain"), vote("abstain")]);
    expect(r.outcome).toBe("deny");
    expect(r.reason).toMatch(/abstaining panel denies/);
  });

  test("abstains equalling valid votes denies (incapacitated outranks tie)", () => {
    // 1 allow / 1 deny / 2 abstain: X(2) ≥ A+D(2) → deny, not tie.
    const r = aggregate([vote("allow"), vote("deny"), vote("abstain"), vote("abstain")]);
    expect(r.outcome).toBe("deny");
  });

  test("split panel signals tie", () => {
    const r = aggregate([vote("allow"), vote("deny")]);
    expect(r.outcome).toBe("tie");
  });

  test("majority deny denies regardless of confidence", () => {
    const r = aggregate([vote("deny", 0.1), vote("deny", 0.1), vote("allow", 1)], 0.9);
    expect(r.outcome).toBe("deny");
  });

  test("non-robust allow majority defers — hidden abstains could flip it", () => {
    // 2 allow / 1 deny / 2 abstain: A(2) > D(1) but A ≤ D+X(3) → defer.
    const r = aggregate([vote("allow"), vote("allow"), vote("deny"), vote("abstain"), vote("abstain")]);
    expect(r.outcome).toBe("defer");
    expect(r.reason).toMatch(/non-robust/);
  });

  test("robust allow majority above bar allows", () => {
    const r = aggregate([vote("allow", 0.9), vote("allow", 0.8), vote("deny", 1)], 0.7);
    expect(r.outcome).toBe("allow");
  });

  test("robust allow majority below confidence bar defers", () => {
    const r = aggregate([vote("allow", 0.5), vote("allow", 0.4), vote("deny", 0.1)], 0.7);
    expect(r.outcome).toBe("defer");
    expect(r.reason).toMatch(/confidence bar/);
  });

  test("confidence bar measures the allowing majority only", () => {
    // Deny's low confidence must not drag the allow mean down.
    const r = aggregate([vote("allow", 0.9), vote("allow", 0.9), vote("deny", 0)], 0.8);
    expect(r.outcome).toBe("allow");
  });

  test("default bar of 0 means no confidence gate", () => {
    const r = aggregate([vote("allow", 0), vote("allow", 0), vote("deny", 0)]);
    expect(r.outcome).toBe("allow");
  });
});

describe("planDiversity — Gate 22, sovereignty-bounded", () => {
  const seat = (name: string, model_class?: "local-only" | "frontier" | "any"): SeatSpec => ({
    name,
    capability: "review.x",
    prompt: "p",
    ...(model_class ? { sovereignty: { model_class } } : {}),
  });

  test("single seat: no diversity requirement", () => {
    const plan = planDiversity([seat("a", "frontier")]);
    expect(plan.diversity.reassigned_seat).toBeUndefined();
    expect(plan.seats).toHaveLength(1);
  });

  test("diverse panel passes through unchanged", () => {
    const seats = [seat("a", "frontier"), seat("b", "local-only")];
    const plan = planDiversity(seats);
    expect(plan.seats).toBe(seats);
    expect(plan.diversity.classes).toEqual(["frontier", "local-only"]);
  });

  test("frontier monoculture reassigns the last seat to local-only", () => {
    const plan = planDiversity([seat("a", "frontier"), seat("b", "frontier")]);
    expect(plan.diversity.reassigned_seat).toBe("b");
    expect(plan.seats[1].sovereignty?.model_class).toBe("local-only");
    expect(plan.seats[1].sovereignty?.frontier_ok).toBe(false);
    expect(plan.seats[0].sovereignty?.model_class).toBe("frontier");
  });

  test("undeclared classes count as 'any' monoculture and reassign", () => {
    const plan = planDiversity([seat("a"), seat("b")]);
    expect(plan.diversity.reassigned_seat).toBe("b");
    expect(plan.seats[1].sovereignty?.model_class).toBe("local-only");
  });

  test("local-only monoculture is never loosened — marked unsatisfiable", () => {
    const plan = planDiversity([seat("a", "local-only"), seat("b", "local-only")]);
    expect(plan.diversity.unsatisfiable).toBe(true);
    expect(plan.diversity.reassigned_seat).toBeUndefined();
    for (const s of plan.seats) {
      expect(s.sovereignty?.model_class).toBe("local-only");
    }
  });
});

describe("post-hoc diversity + downgrade", () => {
  test("duplicate executing models flag posthoc monoculture", () => {
    const votes = [
      { ...vote("allow"), model: "gpt-x" },
      { ...vote("allow", 1, "b"), model: "gpt-x" },
    ];
    const d = checkPosthocDiversity(votes, { classes: ["frontier", "local-only"] });
    expect(d.posthoc_monoculture).toBe(true);
  });

  test("distinct or missing models do not flag", () => {
    const votes = [{ ...vote("allow"), model: "m1" }, vote("allow", 1, "b")];
    const d = checkPosthocDiversity(votes, { classes: ["a", "b"] });
    expect(d.posthoc_monoculture).toBeUndefined();
  });

  test("only the allowing coalition is checked — a denier sharing a model does not flag", () => {
    // Diverse allowing coalition (m1 + m2); the deny vote shares m2 with the
    // tiebreaker-style allow. The coalition that GRANTS permission is diverse,
    // so no downgrade (sage review on PR #31).
    const votes = [
      { ...vote("allow", 1, "a"), model: "m1" },
      { ...vote("deny", 1, "b"), model: "m2" },
      { ...vote("allow", 1, "oracle"), model: "m2" },
    ];
    const d = checkPosthocDiversity(votes, { classes: ["a", "b"] });
    expect(d.posthoc_monoculture).toBeUndefined();
  });

  test("duplicate models within the allowing coalition flag even via tiebreaker", () => {
    const votes = [
      { ...vote("allow", 1, "a"), model: "m1" },
      { ...vote("deny", 1, "b"), model: "m2" },
      { ...vote("allow", 1, "oracle"), model: "m1" },
    ];
    const d = checkPosthocDiversity(votes, { classes: ["a", "b"] });
    expect(d.posthoc_monoculture).toBe(true);
  });

  test("allow downgrades to defer when diversity unsatisfiable", () => {
    const r = applyDiversityDowngrade({ outcome: "allow", reason: "ok" }, { classes: [], unsatisfiable: true });
    expect(r.outcome).toBe("defer");
    expect(r.reason).toMatch(/unsatisfiable/);
  });

  test("allow downgrades to defer on posthoc monoculture", () => {
    const r = applyDiversityDowngrade(
      { outcome: "allow", reason: "ok" },
      { classes: [], posthoc_monoculture: true },
    );
    expect(r.outcome).toBe("defer");
    expect(r.reason).toMatch(/identical executing models/);
  });

  test("deny is never altered by diversity downgrades", () => {
    const r = applyDiversityDowngrade(
      { outcome: "deny", reason: "no" },
      { classes: [], unsatisfiable: true, posthoc_monoculture: true },
    );
    expect(r.outcome).toBe("deny");
    expect(r.reason).toBe("no");
  });

  test("clean diversity leaves allow untouched", () => {
    const r = applyDiversityDowngrade({ outcome: "allow", reason: "ok" }, { classes: ["a", "b"] });
    expect(r.outcome).toBe("allow");
  });
});

describe("abstainVote", () => {
  test("carries cause, zero confidence, abstain verdict", () => {
    const v = abstainVote("sec", "seat timeout after 30ms", "m1");
    expect(v).toEqual({
      seat: "sec",
      verdict: "abstain",
      confidence: 0,
      reason: "",
      model: "m1",
      abstain_cause: "seat timeout after 30ms",
    });
  });
});
