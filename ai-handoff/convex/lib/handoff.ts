export type Mode = "ai" | "human" | "waiting_human";
export type HandoffReason = "phone_reply" | "ai_request" | "manual" | "media" | "limit" | "ai_error";
export type Source = "customer" | "ai" | "phone";

export type HandoffState = {
  mode: Mode;
  modeChangedAt: number;
  aiTurn: number;
  lastFrom: Source;
  handoffReason?: HandoffReason;
  handoffSummary?: string;
  humanActiveAt?: number;
  resumeAt?: number;
  lastError?: string;
};

export type HandoffEvent =
  | { kind: "customer_text"; stale: boolean }
  | { kind: "customer_media" }
  | { kind: "phone_echo" }
  | { kind: "take_over" }
  | { kind: "hand_back" }
  | { kind: "ai_handoff"; summary: string }
  | { kind: "ai_limit" }
  | { kind: "ai_error"; error: string };

export type Effect = { kind: "schedule_reply"; delayMs: number } | { kind: "cancel_reply" };
export type Window = { open: boolean; closesAt?: number };

export const REPLY_DEBOUNCE_MS = 4000;
export const STALE_MESSAGE_MS = 900_000;
export const WINDOW_MS = 86_400_000;
export const AI_REPLY_LIMIT = 20;
export const AI_REPLY_WINDOW_MS = 3_600_000;
export const MODEL_TIMEOUT_MS = 60_000;
export const MODEL_RETRY_DELAY_MS = 10_000;
export const MAX_MODEL_STEPS = 3;
export const HISTORY_MESSAGES = 30;
export const REPLY_MAX_CHARS = 600;
export const SEND_TIMEOUT_MS = 30_000;

type Opts = { now: number; idleMinutes: number; aiEnabled: boolean };
type Result = { state: HandoffState; effects: Effect[] };

const schedule = (delayMs: number): Effect[] => [{ kind: "schedule_reply", delayMs }];
const cancel: Effect[] = [{ kind: "cancel_reply" }];

/** Back to `ai`: clears reason, summary, timers and the last error. */
function toAi(state: HandoffState, now: number): HandoffState {
  return {
    ...state,
    mode: "ai",
    modeChangedAt: now,
    aiTurn: state.aiTurn + 1,
    handoffReason: undefined,
    handoffSummary: undefined,
    humanActiveAt: undefined,
    resumeAt: undefined,
    lastError: undefined,
  };
}

function toWaiting(state: HandoffState, now: number, reason: HandoffReason, extra: Partial<HandoffState> = {}): HandoffState {
  return {
    ...state,
    mode: "waiting_human",
    modeChangedAt: now,
    aiTurn: state.aiTurn + 1,
    handoffReason: reason,
    ...extra,
  };
}

function toHuman(state: HandoffState, o: Opts, reason: HandoffReason): HandoffState {
  return {
    ...state,
    mode: "human",
    modeChangedAt: o.now,
    aiTurn: state.aiTurn + 1,
    handoffReason: reason,
    humanActiveAt: o.now,
    resumeAt: o.now + o.idleMinutes * 60_000,
  };
}

function step(state: HandoffState, event: HandoffEvent, o: Opts): Result {
  const { now } = o;
  switch (event.kind) {
    case "customer_text":
      if (state.mode === "ai") {
        if (event.stale) return { state, effects: [] };
        return { state: { ...state, aiTurn: state.aiTurn + 1 }, effects: schedule(REPLY_DEBOUNCE_MS) };
      }
      if (state.mode === "human" && now >= (state.resumeAt ?? 0)) {
        return { state: toAi(state, now), effects: event.stale ? [] : schedule(REPLY_DEBOUNCE_MS) };
      }
      return { state, effects: [] };
    case "customer_media":
      if (state.mode === "ai") return { state: toWaiting(state, now, "media"), effects: cancel };
      if (state.mode === "human" && now >= (state.resumeAt ?? 0)) {
        return { state: toWaiting(state, now, "media"), effects: [] };
      }
      return { state, effects: [] };
    case "phone_echo":
      return { state: toHuman(state, o, "phone_reply"), effects: cancel };
    case "take_over":
      return { state: toHuman(state, o, "manual"), effects: cancel };
    case "hand_back":
      if (state.mode === "ai") return { state, effects: [] };
      return { state: toAi(state, now), effects: state.lastFrom === "customer" ? schedule(0) : [] };
    case "ai_handoff":
      if (state.mode !== "ai") return { state, effects: [] };
      return { state: toWaiting(state, now, "ai_request", { handoffSummary: event.summary }), effects: [] };
    case "ai_limit":
      if (state.mode !== "ai") return { state, effects: [] };
      return { state: toWaiting(state, now, "limit"), effects: [] };
    case "ai_error":
      if (state.mode !== "ai") return { state, effects: [] };
      return { state: toWaiting(state, now, "ai_error", { lastError: event.error }), effects: [] };
  }
}

/** Decides who answers next. Pure: callers apply the effects in the same mutation. */
export function transition(state: HandoffState, event: HandoffEvent, opts: Opts): Result {
  const result = step(state, event, opts);
  if (opts.aiEnabled) return result;
  return { state: result.state, effects: result.effects.filter((e) => e.kind !== "schedule_reply") };
}

/** The 24h customer-service window: open iff the contact wrote less than 24h ago. */
export function windowState(c: { lastInboundAt?: number }, now: number): Window {
  if (c.lastInboundAt === undefined) return { open: false };
  const closesAt = c.lastInboundAt + WINDOW_MS;
  return { open: now < closesAt, closesAt };
}

export function replyLimitReached(r: { windowStart: number; count: number }, now: number): boolean {
  return now - r.windowStart < AI_REPLY_WINDOW_MS && r.count >= AI_REPLY_LIMIT;
}

export function countReply(
  r: { windowStart: number; count: number },
  now: number,
): { windowStart: number; count: number } {
  if (now - r.windowStart >= AI_REPLY_WINDOW_MS) return { windowStart: now, count: 1 };
  return { windowStart: r.windowStart, count: r.count + 1 };
}

const PREVIEW_LENGTH = 120;

export function previewOf(m: { type: string; text?: string }): string {
  if (!m.text) return `[${m.type}]`;
  return m.text.length > PREVIEW_LENGTH ? `${m.text.slice(0, PREVIEW_LENGTH)}…` : m.text;
}

const REASON_LABELS: Record<HandoffReason, string> = {
  phone_reply: "Your team replied from the phone",
  ai_request: "The AI asked for a person",
  manual: "Taken over from the dashboard",
  media: "The customer sent media",
  limit: "The AI reached 20 replies in an hour",
  ai_error: "The AI could not answer",
};

export function reasonLabel(reason: HandoffReason): string {
  return REASON_LABELS[reason];
}
