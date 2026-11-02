// Pure helpers for WhatsApp chat-history payloads (field "history").
// Payloads come from the network, so every accessor tolerates any shape.

import { contentOf, list, waTimestampMs } from "./payload";

/** Error code Meta sends when the business declines the history share. */
export const DECLINED_CODE = 2593109;

export type HistorySummary = {
  declined: boolean;
  progress?: number;
  phase?: number;
  chunkOrder?: number;
  messageCount: number;
  mediaFollowUp: boolean;
};

export type HistoryRow = {
  threadId: string;
  wamid: string;
  source: "customer" | "phone";
  type: string;
  text?: string;
  sentAt: number;
};

function historyItems(payload: unknown): any[] {
  return list((payload as any)?.whatsapp?.history);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function summarizeHistory(payload: unknown): HistorySummary {
  const items = historyItems(payload);
  const summary: HistorySummary = {
    declined: false,
    messageCount: 0,
    mediaFollowUp: false,
  };
  let metadataSeen = false;
  for (const item of items) {
    if (list(item?.errors).some((error) => error?.code === DECLINED_CODE)) {
      summary.declined = true;
    }
    const metadata = item?.metadata;
    if (metadata && typeof metadata === "object") {
      if (!metadataSeen) {
        metadataSeen = true;
        const phase = finiteNumber(metadata.phase);
        const chunkOrder = finiteNumber(metadata.chunk_order);
        if (phase !== undefined) summary.phase = phase;
        if (chunkOrder !== undefined) summary.chunkOrder = chunkOrder;
      }
      const progress = finiteNumber(metadata.progress);
      if (progress !== undefined) {
        summary.progress = Math.max(summary.progress ?? progress, progress);
      }
    }
    for (const thread of list(item?.threads)) {
      summary.messageCount += list(thread?.messages).length;
    }
  }
  const hasHistoryArray = Array.isArray((payload as any)?.whatsapp?.history);
  summary.mediaFollowUp =
    !hasHistoryArray && list((payload as any)?.whatsapp?.messages).length > 0;
  return summary;
}

export function flattenHistory(payload: unknown): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const item of historyItems(payload)) {
    for (const thread of list(item?.threads)) {
      if (typeof thread?.id !== "string") continue;
      for (const msg of list(thread.messages)) {
        if (typeof msg?.id !== "string") continue;
        const sentAt = waTimestampMs(msg?.timestamp, NaN);
        if (!Number.isFinite(sentAt)) continue;
        const { type, text } = contentOf(msg);
        const row: HistoryRow = {
          threadId: thread.id,
          wamid: msg.id,
          source: typeof msg.to === "string" && msg.to.length > 0 ? "phone" : "customer",
          type,
          sentAt,
        };
        if (text !== undefined) row.text = text;
        rows.push(row);
      }
    }
  }
  return rows;
}

/**
 * Splits messages into conversation segments: a gap longer than `inactivityMs`
 * between consecutive messages starts a new segment. Output is sorted by
 * sentAt, then wamid.
 */
export function segmentMessages<M extends { wamid: string; sentAt: number }>(
  messages: M[],
  inactivityMs: number,
): M[][] {
  const sorted = [...messages].sort(
    (a, b) => a.sentAt - b.sentAt || (a.wamid < b.wamid ? -1 : a.wamid > b.wamid ? 1 : 0),
  );
  const segments: M[][] = [];
  for (const message of sorted) {
    const current = segments[segments.length - 1];
    const previous = current?.[current.length - 1];
    if (current && previous && message.sentAt - previous.sentAt <= inactivityMs) {
      current.push(message);
    } else {
      segments.push([message]);
    }
  }
  return segments;
}
