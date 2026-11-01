import { expect, test } from "vitest";
import { contactLabel, formatAgo, formatRelative, liveWindow, sendFailure } from "./format";

const NOW = Date.UTC(2026, 10, 1, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("formatRelative", () => {
  expect(formatRelative(NOW - 10_000, NOW)).toBe("just now");
  expect(formatRelative(NOW + 10_000, NOW)).toBe("in less than a minute");
  expect(formatRelative(NOW - 5 * MINUTE, NOW)).toBe("5 minutes ago");
  expect(formatRelative(NOW + 23.9 * HOUR, NOW)).toBe("in 23 hours");
  expect(formatRelative(NOW - 30 * HOUR, NOW)).toBe("yesterday");
  expect(formatRelative(NOW - 3 * 24 * HOUR, NOW)).toBe("3 days ago");
});

test("liveWindow closes without a new query result", () => {
  expect(liveWindow({ open: true, closesAt: NOW + HOUR }, NOW)).toEqual({ open: true, closesAt: NOW + HOUR });
  expect(liveWindow({ open: true, closesAt: NOW - 1 }, NOW)).toEqual({ open: false, closesAt: NOW - 1 });
  expect(liveWindow({ open: false }, NOW)).toEqual({ open: false });
});

test("sendFailure maps codes and keeps sentences", () => {
  expect(sendFailure("window_closed")).toMatch(/^The 24-hour window is closed/);
  expect(sendFailure("meta_131026")).toBe("Sending failed (meta_131026).");
  expect(sendFailure("Draft is no longer pending")).toBe("Draft is no longer pending");
});

test("contactLabel prefers the name, then the phone", () => {
  expect(contactLabel({ name: "Ana", phone: "5511900000000" })).toBe("Ana");
  expect(contactLabel({ phone: "5511900000000" })).toBe("+5511900000000");
  expect(contactLabel({ userId: "BR.123" })).toBe("BR.123");
});

test("formatAgo never reads as the future", () => {
  expect(formatAgo(NOW + 2_000, NOW)).toBe("just now");
  expect(formatAgo(NOW - 2 * HOUR, NOW)).toBe("2 hours ago");
});
