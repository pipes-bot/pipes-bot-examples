import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent } from "./format";

describe("formatDuration", () => {
  it("shows a dash when there is no value", () => {
    expect(formatDuration(undefined)).toBe("—");
  });
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(720)).toBe("12m");
    expect(formatDuration(3900)).toBe("1h 05m");
  });
});

describe("formatPercent", () => {
  it("shows a dash when there is no value", () => {
    expect(formatPercent(undefined)).toBe("—");
  });
  it("rounds to a whole percent", () => {
    expect(formatPercent(2 / 3)).toBe("67%");
  });
});
