import type { Source } from "./metrics";

const LABELS: Record<Source, string> = {
  customer: "Customer",
  phone: "Agent (phone)",
  api: "Agent (API)",
};

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function contentOf(message: { source: Source; type: string; text?: string }): string {
  if (message.type === "text") {
    if (message.text) return message.text;
    return message.source === "api" ? "[content not available]" : "[text]";
  }
  return message.text ? `[${message.type}] ${message.text}` : `[${message.type}]`;
}

export function buildTranscript(
  messages: { source: Source; sentAt: number; type: string; text?: string }[],
): string {
  return [...messages]
    .sort((a, b) => a.sentAt - b.sentAt)
    .map((m) => `[${clock(m.sentAt)}] ${LABELS[m.source]}: ${contentOf(m)}`)
    .join("\n");
}
