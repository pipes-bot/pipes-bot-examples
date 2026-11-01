import { describe, expect, test } from "vitest";
import {
  countReply,
  previewOf,
  reasonLabel,
  replyLimitReached,
  transition,
  windowState,
  WINDOW_MS,
  type HandoffEvent,
  type HandoffState,
} from "./handoff";

const S: HandoffState = { mode: "ai", modeChangedAt: 0, aiTurn: 5, lastFrom: "customer" };
const opts = { now: 1000, idleMinutes: 30, aiEnabled: true };
const run = (state: HandoffState, event: HandoffEvent, o = opts) => transition(state, event, o);
const human: HandoffState = { ...S, mode: "human", handoffReason: "phone_reply", humanActiveAt: 0, resumeAt: 2000 };
const waiting: HandoffState = { ...S, mode: "waiting_human", handoffReason: "ai_request", handoffSummary: "wants a refund" };
const text: HandoffEvent = { kind: "customer_text", stale: false };

describe("transition", () => {
  test("ai + text schedules a reply", () => {
    const r = run(S, text);
    expect(r.state).toEqual({ ...S, aiTurn: 6 });
    expect(r.effects).toEqual([{ kind: "schedule_reply", delayMs: 4000 }]);
  });

  test("ai + media waits for a human", () => {
    const r = run(S, { kind: "customer_media" });
    expect(r.state).toMatchObject({ mode: "waiting_human", handoffReason: "media", aiTurn: 6, modeChangedAt: 1000 });
    expect(r.effects).toEqual([{ kind: "cancel_reply" }]);
  });

  test("human before resumeAt ignores the customer", () => {
    for (const e of [text, { kind: "customer_media" } as const]) {
      const r = run(human, e);
      expect(r.state).toBe(human);
      expect(r.effects).toEqual([]);
    }
  });

  test("human after resumeAt resumes the AI", () => {
    const h = { ...human, resumeAt: 1000, handoffSummary: "x", lastError: "boom" };
    const r = run(h, text);
    expect(r.state.mode).toBe("ai");
    expect(r.state.resumeAt).toBeUndefined();
    expect(r.state.handoffSummary).toBeUndefined();
    expect(r.state.handoffReason).toBeUndefined();
    expect(r.state.humanActiveAt).toBeUndefined();
    expect(r.state.aiTurn).toBe(6);
    expect(r.state.modeChangedAt).toBe(1000);
    expect(r.effects).toEqual([{ kind: "schedule_reply", delayMs: 4000 }]);
  });

  test("human after resumeAt with media waits", () => {
    const r = run({ ...human, resumeAt: 1000 }, { kind: "customer_media" });
    expect(r.state).toMatchObject({ mode: "waiting_human", handoffReason: "media", aiTurn: 6, modeChangedAt: 1000 });
    expect(r.effects).toEqual([]);
  });

  test("waiting_human ignores the customer", () => {
    for (const e of [text, { kind: "customer_media" } as const]) {
      const r = run(waiting, e);
      expect(r.state).toBe(waiting);
      expect(r.effects).toEqual([]);
    }
  });

  test("echo hands to staff from any mode", () => {
    for (const from of [S, human, waiting]) {
      const r = run(from, { kind: "phone_echo" });
      expect(r.state).toMatchObject({
        mode: "human",
        handoffReason: "phone_reply",
        humanActiveAt: 1000,
        resumeAt: 1000 + 30 * 60_000,
        aiTurn: 6,
        modeChangedAt: 1000,
      });
      expect(r.effects).toEqual([{ kind: "cancel_reply" }]);
    }
    expect(run(waiting, { kind: "phone_echo" }).state.handoffSummary).toBe("wants a refund");
  });

  test("take over", () => {
    for (const from of [S, human, waiting]) {
      const r = run(from, { kind: "take_over" });
      expect(r.state).toMatchObject({
        mode: "human",
        handoffReason: "manual",
        humanActiveAt: 1000,
        resumeAt: 1000 + 30 * 60_000,
        aiTurn: 6,
      });
      expect(r.effects).toEqual([{ kind: "cancel_reply" }]);
    }
  });

  test("hand back schedules when the customer spoke last", () => {
    const r = run(waiting, { kind: "hand_back" });
    expect(r.state).toMatchObject({ mode: "ai", aiTurn: 6, modeChangedAt: 1000 });
    expect(r.state.handoffReason).toBeUndefined();
    expect(r.state.handoffSummary).toBeUndefined();
    expect(r.effects).toEqual([{ kind: "schedule_reply", delayMs: 0 }]);
    expect(run(human, { kind: "hand_back" }).effects).toEqual([{ kind: "schedule_reply", delayMs: 0 }]);
  });

  test("hand back without a pending customer message", () => {
    const r = run({ ...waiting, lastFrom: "ai" }, { kind: "hand_back" });
    expect(r.state.mode).toBe("ai");
    expect(r.state.aiTurn).toBe(6);
    expect(r.effects).toEqual([]);
  });

  test("hand back in ai mode changes nothing", () => {
    const r = run(S, { kind: "hand_back" });
    expect(r.state).toBe(S);
    expect(r.effects).toEqual([]);
  });

  test("ai_handoff stores the summary", () => {
    const r = run(S, { kind: "ai_handoff", summary: "wants a refund" });
    expect(r.state).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_request",
      handoffSummary: "wants a refund",
      aiTurn: 6,
      modeChangedAt: 1000,
    });
    expect(r.effects).toEqual([]);
  });

  test("ai_limit", () => {
    const r = run(S, { kind: "ai_limit" });
    expect(r.state).toMatchObject({ mode: "waiting_human", handoffReason: "limit", aiTurn: 6 });
    expect(r.effects).toEqual([]);
  });

  test("ai_error stores lastError", () => {
    const r = run(S, { kind: "ai_error", error: "model timed out" });
    expect(r.state).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_error",
      lastError: "model timed out",
      aiTurn: 6,
    });
    expect(r.effects).toEqual([]);
  });

  test("ai events outside ai mode change nothing", () => {
    const events: HandoffEvent[] = [
      { kind: "ai_error", error: "x" },
      { kind: "ai_handoff", summary: "x" },
      { kind: "ai_limit" },
    ];
    for (const from of [human, waiting]) {
      for (const e of events) {
        const r = run(from, e);
        expect(r.state).toBe(from);
        expect(r.effects).toEqual([]);
      }
    }
  });

  test("ai_error outside ai mode changes nothing", () => {
    const r = run(human, { kind: "ai_error", error: "x" });
    expect(r.state).toBe(human);
    expect(r.effects).toEqual([]);
  });

  test("aiEnabled false removes scheduling", () => {
    const off = { ...opts, aiEnabled: false };
    const a = run(S, text, off);
    expect(a.state).toEqual({ ...S, aiTurn: 6 });
    expect(a.effects).toEqual([]);
    expect(run(waiting, { kind: "hand_back" }, off).effects).toEqual([]);
    expect(run({ ...human, resumeAt: 1000 }, text, off).effects).toEqual([]);
    expect(run(S, { kind: "phone_echo" }, off).effects).toEqual([{ kind: "cancel_reply" }]);
  });

  test("stale text in ai is a no-op", () => {
    const r = run(S, { kind: "customer_text", stale: true });
    expect(r.state).toBe(S);
    expect(r.effects).toEqual([]);
  });

  test("stale text before resumeAt is a no-op", () => {
    const r = run(human, { kind: "customer_text", stale: true });
    expect(r.state).toBe(human);
    expect(r.effects).toEqual([]);
  });

  test("stale text after resumeAt switches without scheduling", () => {
    const r = run({ ...human, resumeAt: 1000, handoffSummary: "x" }, { kind: "customer_text", stale: true });
    expect(r.state.mode).toBe("ai");
    expect(r.state.aiTurn).toBe(6);
    expect(r.state.resumeAt).toBeUndefined();
    expect(r.state.handoffSummary).toBeUndefined();
    expect(r.effects).toEqual([]);
  });

  test("returning to ai clears lastError", () => {
    const errored = { ...waiting, handoffReason: "ai_error" as const, lastError: "boom" };
    expect(run(errored, { kind: "hand_back" }).state.lastError).toBeUndefined();
    expect(run({ ...errored, mode: "human", resumeAt: 1000 }, text).state.lastError).toBeUndefined();
  });

  test("does not mutate its input", () => {
    const copy = { ...waiting };
    run(waiting, { kind: "phone_echo" });
    expect(waiting).toEqual(copy);
  });
});

describe("reply limit", () => {
  test("replyLimitReached", () => {
    expect(replyLimitReached({ windowStart: 0, count: 20 }, 3_599_999)).toBe(true);
    expect(replyLimitReached({ windowStart: 0, count: 20 }, 3_600_000)).toBe(false);
    expect(replyLimitReached({ windowStart: 0, count: 19 }, 3_599_999)).toBe(false);
  });
  test("countReply", () => {
    expect(countReply({ windowStart: 0, count: 20 }, 3_600_000)).toEqual({ windowStart: 3_600_000, count: 1 });
    expect(countReply({ windowStart: 0, count: 4 }, 1000)).toEqual({ windowStart: 0, count: 5 });
  });
});

describe("windowState", () => {
  test("is closed without an inbound message", () => {
    expect(windowState({}, 0)).toEqual({ open: false });
  });
  test("is open for 24 hours", () => {
    expect(windowState({ lastInboundAt: 1000 }, 1000 + WINDOW_MS - 1)).toEqual({
      open: true,
      closesAt: 1000 + WINDOW_MS,
    });
    expect(windowState({ lastInboundAt: 1000 }, 1000 + WINDOW_MS).open).toBe(false);
  });
});

describe("previewOf", () => {
  test("text, long text and media", () => {
    expect(previewOf({ type: "text", text: "hi" })).toBe("hi");
    expect(previewOf({ type: "image" })).toBe("[image]");
    expect(previewOf({ type: "text", text: "a".repeat(130) })).toBe(`${"a".repeat(120)}…`);
  });
});

describe("reasonLabel", () => {
  test("labels every reason", () => {
    expect(reasonLabel("phone_reply")).toBe("Your team replied from the phone");
    expect(reasonLabel("ai_request")).toBe("The AI asked for a person");
    expect(reasonLabel("manual")).toBe("Taken over from the dashboard");
    expect(reasonLabel("media")).toBe("The customer sent media");
    expect(reasonLabel("limit")).toBe("The AI reached 20 replies in an hour");
    expect(reasonLabel("ai_error")).toBe("The AI could not answer");
  });
});
