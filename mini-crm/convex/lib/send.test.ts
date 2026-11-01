import { describe, expect, test } from "vitest";
import { parseSendFailure, rateLimitDelayMs, sendErrorMessage } from "./send";

describe("parseSendFailure", () => {
  test("service window expired", () => {
    expect(
      parseSendFailure(403, { error: "Service window expired", code: "SERVICE_WINDOW_EXPIRED" }),
    ).toBe("window_closed");
  });
  test("Meta 131047 is a closed window", () => {
    expect(
      parseSendFailure(400, { error: { code: 131047, message: "Re-engagement message" } }),
    ).toBe("window_closed");
  });
  test("other Meta codes", () => {
    expect(parseSendFailure(400, { error: { code: 131026 } })).toBe("meta_131026");
  });
  test("other string codes are lowercased", () => {
    expect(parseSendFailure(500, { code: "NO_CREDENTIALS" })).toBe("no_credentials");
  });
  test("rate limiting", () => {
    expect(parseSendFailure(429, {})).toBe("rate_limited");
    expect(parseSendFailure(400, { code: "RATE_LIMITED" })).toBe("rate_limited");
  });
  test("falls back to the status", () => {
    expect(parseSendFailure(502, "oops")).toBe("http_502");
    expect(parseSendFailure(500, null)).toBe("http_500");
  });
});

describe("rateLimitDelayMs", () => {
  test("clamps the reset time", () => {
    expect(rateLimitDelayMs("100", 90_000)).toBe(10_000);
    expect(rateLimitDelayMs("100", 99_900)).toBe(1_000);
    expect(rateLimitDelayMs("9999999999", 0)).toBe(120_000);
  });
  test("defaults to 60s", () => {
    expect(rateLimitDelayMs(null, 0)).toBe(60_000);
    expect(rateLimitDelayMs("soon", 0)).toBe(60_000);
  });
});

describe("sendErrorMessage", () => {
  test("known and unknown codes", () => {
    expect(sendErrorMessage("window_closed")).toContain("24-hour window is closed");
    expect(sendErrorMessage("invalid_text")).toBe("Message must be 1–4096 characters.");
    expect(sendErrorMessage("meta_131026")).toBe("Sending failed (meta_131026).");
  });
});
