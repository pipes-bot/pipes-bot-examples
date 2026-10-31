import type { Infer } from "convex/values";
import { z } from "zod";
import type { analysisValidator } from "../schema";
import type { Step } from "./methodology";

export type StepResult = NonNullable<Infer<typeof analysisValidator>["steps"]>[number];

export const evaluationSchema = z.object({
  summary: z.string().max(400),
  steps: z.array(
    z.object({
      stepId: z.string(),
      verdict: z.enum(["met", "not_met", "not_applicable"]),
      evidence: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function checkEvaluation(
  output: z.infer<typeof evaluationSchema>,
  steps: Step[],
  transcript: string,
): { ok: true; steps: StepResult[] } | { ok: false; error: string } {
  const expected = new Set(steps.map((s) => s.id));
  const counts = new Map<string, number>();
  for (const { stepId } of output.steps) counts.set(stepId, (counts.get(stepId) ?? 0) + 1);

  const missing = steps.filter((s) => !counts.has(s.id)).map((s) => s.id);
  const extra = [...counts.keys()].filter((id) => !expected.has(id));
  const repeated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  if (missing.length || extra.length || repeated.length) {
    const problems = [
      missing.length && `missing stepIds: ${missing.join(", ")}`,
      extra.length && `unknown stepIds: ${extra.join(", ")}`,
      repeated.length && `repeated stepIds: ${repeated.join(", ")}`,
    ].filter(Boolean);
    return { ok: false, error: problems.join("; ") };
  }

  const haystack = normalize(transcript);
  const byId = new Map(output.steps.map((s) => [s.stepId, s]));
  return {
    ok: true,
    steps: steps.map((step) => {
      const result = byId.get(step.id)!;
      const evidence =
        result.evidence !== null &&
        normalize(result.evidence) !== "" &&
        haystack.includes(normalize(result.evidence))
          ? result.evidence
          : null;
      return { ...result, evidence };
    }),
  };
}

export function scoreOf(steps: StepResult[]): number | undefined {
  const met = steps.filter((s) => s.verdict === "met").length;
  const notMet = steps.filter((s) => s.verdict === "not_met").length;
  if (met + notMet === 0) return undefined;
  return Math.round((100 * met) / (met + notMet));
}
