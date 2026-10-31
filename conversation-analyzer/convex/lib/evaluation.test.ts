import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { checkEvaluation, evaluationSchema, scoreOf } from "./evaluation";
import { DEFAULT_METHODOLOGY } from "./methodology";

type Output = z.infer<typeof evaluationSchema>;

const transcript = [
  "[14:02] Customer: Hi",
  "[14:09] Agent (phone): Hello!",
  "[14:10] Agent (API): [content not available]",
  "[14:11] Customer: [image] blue?",
].join("\n");

const entry = (stepId: string, evidence: string | null = null) => ({
  stepId,
  verdict: "met" as const,
  evidence,
  reason: "because",
});

const output = (ids: string[]): Output => ({ summary: "ok", steps: ids.map((id) => entry(id)) });

describe("evaluationSchema", () => {
  it("rejects summaries over 400 chars", () => {
    expect(evaluationSchema.safeParse({ summary: "x".repeat(401), steps: [] }).success).toBe(false);
    expect(evaluationSchema.safeParse({ summary: "x".repeat(400), steps: [] }).success).toBe(true);
  });
});

describe("checkEvaluation", () => {
  it("returns results in methodology order", () => {
    const result = checkEvaluation(
      output(["close", "greet", "resolve", "understand"]),
      DEFAULT_METHODOLOGY,
      transcript,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps.map((s) => s.stepId)).toEqual(["greet", "understand", "resolve", "close"]);
    }
  });

  it("fails when a step is missing and names it", () => {
    const result = checkEvaluation(output(["greet", "understand", "resolve"]), DEFAULT_METHODOLOGY, transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("close");
  });

  it("fails on an extra step and names it", () => {
    const result = checkEvaluation(
      output(["greet", "understand", "resolve", "close", "upsell"]),
      DEFAULT_METHODOLOGY,
      transcript,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("upsell");
  });

  it("fails on a repeated step and names it", () => {
    const result = checkEvaluation(
      output(["greet", "greet", "understand", "resolve", "close"]),
      DEFAULT_METHODOLOGY,
      transcript,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("greet");
  });

  it("keeps evidence found in the transcript, ignoring case and whitespace", () => {
    const out = output(["greet", "understand", "resolve", "close"]);
    out.steps[0] = entry("greet", "HELLO!");
    out.steps[1] = entry("understand", "agent (phone):   hello!");
    const result = checkEvaluation(out, DEFAULT_METHODOLOGY, transcript);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps[0].evidence).toBe("HELLO!");
      expect(result.steps[1].evidence).toBe("agent (phone):   hello!");
    }
  });

  it("nulls evidence that is not in the transcript, keeping the verdict", () => {
    const out = output(["greet", "understand", "resolve", "close"]);
    out.steps[2] = entry("resolve", "we offer refunds");
    const result = checkEvaluation(out, DEFAULT_METHODOLOGY, transcript);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps[2].evidence).toBeNull();
      expect(result.steps[2].verdict).toBe("met");
    }
  });
});

describe("scoreOf", () => {
  const r = (verdict: "met" | "not_met" | "not_applicable") => ({
    stepId: "x",
    verdict,
    evidence: null,
    reason: "",
  });

  it("is round(100 * met / (met + not_met))", () => {
    expect(scoreOf([r("met"), r("met"), r("not_met"), r("not_applicable")])).toBe(67);
  });

  it("is undefined when nothing applies", () => {
    expect(scoreOf([r("not_applicable"), r("not_applicable")])).toBeUndefined();
    expect(scoreOf([])).toBeUndefined();
  });
});
