import type { Metrics } from "./metrics";

export type Summary = {
  total: number;
  medianFirstResponseSeconds?: number;
  answeredRate?: number;
  avgScore?: number;
};

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(
  conversations: { metrics?: Metrics; analysis?: { score?: number } }[],
): Summary {
  const summary: Summary = { total: conversations.length };
  if (conversations.length === 0) return summary;

  const firstResponses = conversations.flatMap((c) =>
    c.metrics?.firstResponseSeconds === undefined ? [] : [c.metrics.firstResponseSeconds],
  );
  const medianFirstResponse = median(firstResponses);
  if (medianFirstResponse !== undefined) summary.medianFirstResponseSeconds = medianFirstResponse;

  summary.answeredRate = conversations.filter((c) => c.metrics?.answered).length / conversations.length;

  const scores = conversations.flatMap((c) => (c.analysis?.score === undefined ? [] : [c.analysis.score]));
  if (scores.length > 0) summary.avgScore = Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);
  return summary;
}
