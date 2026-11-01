import type { Id } from "../_generated/dataModel";

export type SendError =
  | "window_closed"
  | "number_blocked"
  | "no_recipient"
  | "rate_limited"
  | "not_configured"
  | "unknown"
  | "network_error"
  | (string & {}); // any other API code, e.g. "meta_131026"

export type SendResult = {
  status: "sent" | "queued" | "failed";
  messageId?: Id<"messages">;
  error?: SendError;
};

const META_WINDOW_CLOSED = 131047;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Maps a failed pipes.bot send response to a SendError code. */
export function parseSendFailure(status: number, body: unknown): SendError {
  const code = isRecord(body) ? body.code : undefined;
  if (code === "SERVICE_WINDOW_EXPIRED") return "window_closed";
  if (code === "RATE_LIMITED" || status === 429) return "rate_limited";
  const metaCode = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  if (typeof metaCode === "number") {
    return metaCode === META_WINDOW_CLOSED ? "window_closed" : `meta_${metaCode}`;
  }
  if (typeof code === "string" && code.length > 0) return code.toLowerCase();
  return `http_${status}`;
}

/** `reset` is the X-RateLimit-Reset header (unix seconds). */
export function rateLimitDelayMs(reset: string | null, nowMs: number): number {
  const seconds = reset === null || reset.trim() === "" ? Number.NaN : Number(reset);
  if (!Number.isFinite(seconds)) return 60_000;
  return Math.min(120_000, Math.max(1_000, seconds * 1000 - nowMs));
}

export function sendErrorMessage(error: SendError): string {
  switch (error) {
    case "window_closed":
      return "The 24-hour window is closed. WhatsApp only allows a free-form reply within 24 hours of the contact's last message.";
    case "number_blocked":
      return "This number can't send messages right now. Check its health on the Numbers page.";
    case "rate_limited":
      return "pipes.bot rate limit reached. Try again in a minute.";
    case "not_configured":
      return "PIPES_API_KEY is not set on the Convex deployment.";
    case "unknown":
      return "pipes.bot did not answer in 30 seconds. The message may or may not have been sent.";
    case "network_error":
      return "Could not reach pipes.bot. The message may or may not have been sent.";
    case "no_recipient":
      return "This contact has no phone number or WhatsApp user ID.";
    default:
      return `Sending failed (${error}).`;
  }
}
