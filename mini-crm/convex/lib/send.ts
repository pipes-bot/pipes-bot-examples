import type { Id } from "../_generated/dataModel";

export type SendError =
  | "window_closed"
  | "number_blocked"
  | "number_unavailable"
  | "invalid_text"
  | "no_recipient"
  | "rate_limited"
  | "not_configured"
  | "timeout"
  | "network_error"
  | "invalid_template"
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

/**
 * Maps a failed pipes.bot send response to a SendError code. pipes.bot sends
 * `{ error: { code, message } }`; a top-level `code` is also accepted. On BYON
 * numbers a closed window is Meta `131047`; `SERVICE_WINDOW_EXPIRED` is the
 * sandbox code, kept for safety.
 */
export function parseSendFailure(status: number, body: unknown): SendError {
  const nested = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  if (typeof nested === "number") {
    return nested === META_WINDOW_CLOSED ? "window_closed" : `meta_${nested}`;
  }
  const topCode = isRecord(body) ? body.code : undefined;
  const code =
    typeof topCode === "string" && topCode.length > 0
      ? topCode
      : typeof nested === "string" && nested.length > 0
        ? nested
        : undefined;
  if (code === "SERVICE_WINDOW_EXPIRED") return "window_closed";
  if (code === "RATE_LIMITED" || status === 429) return "rate_limited";
  if (code !== undefined) return code.toLowerCase();
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
    case "number_unavailable":
      return "The number this contact last wrote to is no longer connected to this workspace.";
    case "rate_limited":
      return "pipes.bot rate limit reached. Try again in a minute.";
    case "not_configured":
      return "PIPES_API_KEY is not set on the Convex deployment.";
    case "timeout":
      return "pipes.bot did not answer in 30 seconds. The message may or may not have been sent.";
    case "network_error":
      return "Could not reach pipes.bot. The message may or may not have been sent.";
    case "invalid_text":
      return "Message must be 1–4096 characters.";
    case "no_recipient":
      return "This contact has no phone number or WhatsApp user ID.";
    case "invalid_template":
      return "Invalid template: name must be lowercase letters, digits and underscores, the language a code like en_US, and up to 20 body parameters of 1–1024 characters without newlines, tabs or more than 4 spaces in a row.";
    case "meta_132001":
      return "This template does not exist in this language for the number's WhatsApp Business Account.";
    case "meta_132000":
      return "The number of template parameters does not match the template.";
    case "meta_132015":
      return "This template is paused in Meta because of low quality.";
    default:
      return `Sending failed (${error}).`;
  }
}
