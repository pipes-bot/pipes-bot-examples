import { describe, expect, it } from "vitest";
import { computeMetrics } from "./metrics";

type Msg = Parameters<typeof computeMetrics>[0][number];
const m = (source: Msg["source"], s: number): Msg => ({ source, sentAt: s * 1000 });

const mixed = [
  m("customer", 0),
  m("customer", 60),
  m("phone", 300),
  m("customer", 600),
  m("api", 660),
  m("customer", 900),
];

describe("computeMetrics", () => {
  it("mixed conversation", () => {
    expect(computeMetrics(mixed)).toEqual({
      firstResponseSeconds: 300,
      avgResponseSeconds: 180,
      maxResponseSeconds: 300,
      unansweredTurns: 1,
      answered: true,
      durationSeconds: 900,
      counts: { customer: 4, phone: 1, api: 1 },
    });
  });

  it("business initiated", () => {
    const result = computeMetrics([m("phone", 0), m("customer", 100), m("phone", 160)]);
    expect(result).toEqual({
      avgResponseSeconds: 60,
      maxResponseSeconds: 60,
      unansweredTurns: 0,
      answered: true,
      durationSeconds: 160,
      counts: { customer: 1, phone: 2, api: 0 },
    });
    expect("firstResponseSeconds" in result).toBe(false);
  });

  it("customer only", () => {
    const result = computeMetrics([m("customer", 0), m("customer", 50)]);
    expect(result).toEqual({
      unansweredTurns: 1,
      answered: false,
      durationSeconds: 50,
      counts: { customer: 2, phone: 0, api: 0 },
    });
    expect(Object.keys(result)).not.toContain("firstResponseSeconds");
  });

  it("empty", () => {
    expect(computeMetrics([])).toEqual({
      unansweredTurns: 0,
      answered: false,
      durationSeconds: 0,
      counts: { customer: 0, phone: 0, api: 0 },
    });
  });

  it("business message before any customer message is not a response", () => {
    expect(computeMetrics([m("phone", 0), m("api", 10)]).answered).toBe(false);
  });

  it("unsorted input", () => {
    const shuffled = [mixed[4], mixed[1], mixed[5], mixed[0], mixed[3], mixed[2]];
    expect(computeMetrics(shuffled)).toEqual(computeMetrics(mixed));
  });
});
