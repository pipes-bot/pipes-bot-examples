import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
  STAGES,
  WINDOW_MS,
  cleanText,
  fromLabel,
  isStage,
  normalizeTag,
  normalizeTags,
  previewOf,
  searchTextOf,
  windowState,
} from "./crm";

describe("stages", () => {
  test("STAGES and isStage", () => {
    expect(STAGES).toEqual(["lead", "qualified", "customer", "lost"]);
    expect(isStage("lead")).toBe(true);
    expect(isStage("won")).toBe(false);
    expect(isStage(undefined)).toBe(false);
  });
});

describe("windowState", () => {
  test("no inbound message means closed", () => {
    expect(windowState({}, 5)).toEqual({ open: false });
  });
  test("open until 24h after the last inbound", () => {
    expect(WINDOW_MS).toBe(86_400_000);
    expect(windowState({ lastInboundAt: 0 }, 86_399_999)).toEqual({
      open: true,
      closesAt: 86_400_000,
    });
  });
  test("closed exactly at 24h", () => {
    expect(windowState({ lastInboundAt: 0 }, 86_400_000)).toEqual({
      open: false,
      closesAt: 86_400_000,
    });
  });
});

describe("normalizeTag", () => {
  test("trims, lowercases and collapses whitespace", () => {
    expect(normalizeTag("  Big   Deal ")).toBe("big-deal");
  });
  test("rejects empty and too long", () => {
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag("x".repeat(32))).toBe("x".repeat(32));
    expect(normalizeTag("x".repeat(33))).toBeNull();
  });
});

describe("normalizeTags", () => {
  test("rejects an invalid tag and reports it raw", () => {
    expect(normalizeTags(["vip"], ["  VIP ", "Big Deal", ""], [])).toEqual({
      error: 'Tag "" must be 1–32 characters',
    });
  });
  test("removes first, then adds, deduping in first-seen order", () => {
    expect(normalizeTags(["vip", "cold"], ["Big  Deal"], ["COLD"])).toEqual({
      tags: ["vip", "big-deal"],
    });
    expect(normalizeTags(["vip"], ["  VIP ", "vip"])).toEqual({ tags: ["vip"] });
  });
  test("re-adding a removed tag keeps it", () => {
    expect(normalizeTags(["a"], ["a"], ["a"])).toEqual({ tags: ["a"] });
  });
  test("caps at 20 tags", () => {
    const current = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(normalizeTags(current, ["extra"])).toEqual({
      error: "A contact can have at most 20 tags",
    });
    expect(normalizeTags(current, ["t0"])).toEqual({ tags: current });
  });
});

describe("cleanText", () => {
  test("trims", () => {
    expect(cleanText("  hi ", 10, "Note")).toBe("hi");
  });
  test("throws ConvexError when empty or too long", () => {
    for (const raw of ["   ", "x".repeat(11)]) {
      try {
        cleanText(raw, 10, "Note");
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ConvexError);
        expect((e as ConvexError<string>).data).toBe("Note must be 1–10 characters");
      }
    }
  });
});

describe("fromLabel", () => {
  test("maps sources", () => {
    expect(fromLabel({ source: "contact" })).toBe("contact");
    expect(fromLabel({ source: "app" })).toBe("you");
    expect(fromLabel({ source: "phone" })).toBe("phone");
    expect(fromLabel({ source: "mcp" })).toBe("MCP");
    expect(fromLabel({ source: "mcp", clientName: "Claude" })).toBe("Claude");
  });
});

describe("searchTextOf", () => {
  test("joins defined values", () => {
    expect(searchTextOf({ name: "Ana", waId: "5511", userId: undefined })).toBe("Ana 5511");
    expect(searchTextOf({})).toBe("");
  });
});

describe("previewOf", () => {
  test("falls back to the type", () => {
    expect(previewOf({ type: "image" })).toBe("[image]");
  });
  test("truncates long text to 120 chars plus an ellipsis", () => {
    const out = previewOf({ type: "text", text: "a".repeat(130) });
    expect(out).toHaveLength(121);
    expect(out.endsWith("…")).toBe(true);
    expect(previewOf({ type: "text", text: "short" })).toBe("short");
  });
});
