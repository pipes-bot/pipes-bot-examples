// Pure bot logic: frames in, frames out. No I/O, so it is easy to test.
export type Mode = "sandbox" | "byon";

// The key prefix decides the mode: pk_ = sandbox, ak_ = BYON API v2.
export function modeFromKey(key: string | undefined): Mode {
  if (key?.startsWith("pk_")) return "sandbox";
  if (key?.startsWith("ak_")) return "byon";
  throw new Error("PIPES_API_KEY must start with pk_ or ak_");
}

// In-memory dedup, capped at `limit` entries. In production, keep this in your database.
// Returns true the first time an id is seen.
export function createDedup(limit = 1000): (id: string) => boolean {
  const seen = new Set<string>();
  return (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > limit) seen.delete(seen.values().next().value!);
    return true;
  };
}

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Turns one incoming frame into the frames to send back (usually zero or one).
// `log` receives the shared log lines; it defaults to a no-op to keep this module free of I/O.
export function repliesFor(
  frame: any,
  mode: Mode,
  isNew: (id: string) => boolean,
  log: (line: string) => void = () => {},
): object[] {
  if (!isObject(frame) || !isObject(frame.data)) return [];
  const data = frame.data;

  if (mode === "sandbox") {
    if (frame.type !== "whatsapp_message") return [];
    if (typeof data.messageId !== "string") return log("skipped missing-id -"), [];
    const id = data.messageId;
    if (!isNew(id)) return log(`duplicate ${id}`), [];
    if (data.type !== "text") return log(`skipped ${String(data.type)} ${id}`), [];
    if (typeof data.conversationId !== "string" || typeof data.fromNumber !== "string") {
      return log(`skipped missing-recipient ${id}`), [];
    }
    log(`received message ${id}`);
    const text = typeof data.text === "string" ? data.text : "";
    return [
      {
        type: "whatsapp_reply",
        data: { conversationId: data.conversationId, toNumber: data.fromNumber, text: `Echo: ${text}` },
      },
    ];
  }

  // BYON API v2: `event` frames carry the same envelope as the webhook.
  if (frame.type !== "event") return [];
  if (typeof data.id !== "string") return log("skipped missing-id -"), [];
  const eventId = data.id; // dedup on the event id, not on the wamid (statuses share it)
  if (!isNew(eventId)) return log(`duplicate ${eventId}`), [];
  // Statuses, echoes and system events are skipped, so the bot never answers itself.
  if (data.field !== "messages") return log(`skipped ${String(data.field)} ${eventId}`), [];
  const messages = data.whatsapp?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return log(`skipped no-messages ${eventId}`), [];
  const poolNumberId = data.pipes?.poolNumberId;

  const replies: object[] = [];
  for (const message of messages) {
    if (!isObject(message)) continue;
    if (typeof message.id !== "string") {
      log("skipped missing-id -");
      continue;
    }
    if (message.type !== "text") {
      log(`skipped ${String(message.type)} ${message.id}`);
      continue;
    }
    // Users who hide their phone number only have a BSUID: reply with `recipient`.
    const from = typeof message.from === "string" && message.from ? message.from : undefined;
    const bsuid = typeof message.from_user_id === "string" ? message.from_user_id : undefined;
    if (typeof poolNumberId !== "string" || !(from ?? bsuid)) {
      log(`skipped missing-recipient ${message.id}`);
      continue;
    }
    log(`received message ${message.id}`);
    const body = typeof message.text?.body === "string" ? message.text.body : "";
    replies.push({
      type: "send",
      requestId: message.id,
      poolNumberId,
      message: {
        messaging_product: "whatsapp",
        ...(from ? { to: from } : { recipient: bsuid }),
        type: "text",
        text: { body: `Echo: ${body}` },
      },
    });
  }
  return replies;
}

// Describes the server's answer to a reply: `send_result` (BYON v2) or `reply_status` (sandbox).
// Returns undefined for any other frame.
export function resultLine(frame: any): { ok: boolean; line: string } | undefined {
  if (!isObject(frame)) return undefined;
  if (frame.type === "send_result") {
    if (frame.success === true) return { ok: true, line: `replied ${frame.requestId}` };
    return { ok: false, line: `send failed ${frame.requestId}: ${JSON.stringify(frame.error)}` };
  }
  if (frame.type === "reply_status" && isObject(frame.data)) {
    const { conversationId, success, error, code } = frame.data;
    if (success === true) return { ok: true, line: `replied ${conversationId}` };
    return { ok: false, line: `send failed ${conversationId}: ${error ?? "unknown error"}${code ? ` (${code})` : ""}` };
  }
  return undefined;
}
