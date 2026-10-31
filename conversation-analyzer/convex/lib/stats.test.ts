import { describe, expect, it } from "vitest";
import { summarize } from "./stats";

const metrics = (firstResponseSeconds: number | undefined, answered: boolean) => ({
  ...(firstResponseSeconds === undefined ? {} : { firstResponseSeconds }),
  unansweredTurns: 0,
  answered,
  durationSeconds: 0,
  counts: { customer: 0, phone: 0, api: 0 },
});

describe("summarize", () => {
  it("aggregates conversations", () => {
    expect(
      summarize([
        { metrics: metrics(10, true), analysis: { score: 50 } },
        { metrics: metrics(30, true), analysis: { score: 100 } },
        { metrics: metrics(undefined, false), analysis: {} },
      ]),
    ).toEqual({ total: 3, medianFirstResponseSeconds: 20, answeredRate: 2 / 3, avgScore: 75 });
  });

  it("returns only total when empty", () => {
    expect(summarize([])).toEqual({ total: 0 });
  });

  it("uses the middle value for odd counts", () => {
    expect(
      summarize([{ metrics: metrics(5, true) }, { metrics: metrics(50, true) }, { metrics: metrics(9, true) }])
        .medianFirstResponseSeconds,
    ).toBe(9);
  });
});
