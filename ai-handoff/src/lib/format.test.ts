import { describe, expect, it } from "vitest";
import { relativeTime, resumeLabel } from "./format";

const NOW = 1_000_000_000;
const MIN = 60_000;

describe("resumeLabel", () => {
  it("counts the minutes left while staff is active", () => {
    expect(resumeLabel({ mode: "human", resumeAt: NOW + 12 * MIN }, NOW)).toBe("AI back in 12 min");
    expect(resumeLabel({ mode: "human", resumeAt: NOW + 1000 }, NOW)).toBe("AI back in 1 min");
  });
  it("says the AI resumes on the next message once the timer is over", () => {
    expect(resumeLabel({ mode: "human", resumeAt: NOW }, NOW)).toBe("AI resumes on the next message");
    expect(resumeLabel({ mode: "human", resumeAt: NOW - MIN }, NOW)).toBe(
      "AI resumes on the next message",
    );
  });
  it("shows waiting for the team", () => {
    expect(resumeLabel({ mode: "waiting_human" }, NOW)).toBe("Waiting for your team");
  });
  it("shows the AI answering", () => {
    expect(resumeLabel({ mode: "ai" }, NOW)).toBe("AI is answering");
  });
});

describe("relativeTime", () => {
  it("formats minutes, hours and days", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe("5 min ago");
    expect(relativeTime(NOW - 180 * MIN, NOW)).toBe("3 h ago");
    expect(relativeTime(NOW - 48 * 60 * MIN, NOW)).toBe("2 d ago");
  });
});
