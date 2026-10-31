// Helpers for reading pipes.bot / WhatsApp webhook payloads defensively.
// Payloads come from the network, so every accessor tolerates missing fields.

type Ids = { waId?: string; userId?: string };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function idsFrom(waId: unknown, userId: unknown): Ids {
  const ids: Ids = {};
  const wa = nonEmpty(waId);
  const user = nonEmpty(userId);
  if (wa) ids.waId = wa;
  if (user) ids.userId = user;
  return ids;
}

export function list(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/** WhatsApp timestamps are Unix seconds as 1-12 ASCII digits. Returns ms. */
export function waTimestampMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== "string" && typeof value !== "number") return fallbackMs;
  const text = String(value);
  if (!/^[0-9]{1,12}$/.test(text)) return fallbackMs;
  return Number(text) * 1000;
}

export function senderOf(msg: any): Ids {
  return idsFrom(msg?.from, msg?.from_user_id);
}

export function echoRecipientOf(echo: any): Ids {
  return idsFrom(echo?.to, echo?.to_user_id);
}

export function statusRecipientOf(status: any): string | undefined {
  return nonEmpty(status?.recipient_id) ?? nonEmpty(status?.recipient_user_id);
}

export function contentOf(msg: any): { type: string; text?: string } {
  const type = nonEmpty(msg?.type) ?? "unknown";
  let text: unknown;
  switch (type) {
    case "text":
      text = msg?.text?.body;
      break;
    case "image":
    case "video":
    case "document":
      text = msg?.[type]?.caption;
      break;
    case "button":
      text = msg?.button?.text;
      break;
    case "interactive":
      text =
        msg?.interactive?.button_reply?.title ??
        msg?.interactive?.list_reply?.title;
      break;
  }
  return typeof text === "string" ? { type, text } : { type };
}

export function contactName(whatsapp: any, ids: Ids): string | undefined {
  for (const contact of list(whatsapp?.contacts)) {
    const matches =
      (ids.waId !== undefined && contact?.wa_id === ids.waId) ||
      (ids.userId !== undefined && contact?.user_id === ids.userId);
    if (matches) return nonEmpty(contact?.profile?.name);
  }
  return undefined;
}
