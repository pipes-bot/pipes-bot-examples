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
  // One line per message: a newline inside a message must not start a fake line.
  const text = message.text?.replace(/\s+/g, " ").trim();
  if (message.type === "text") {
    if (text) return text;
    return message.source === "api" ? "[content not available]" : "[text]";
  }
  const label = message.type === "media_placeholder" ? "media" : message.type;
  return text ? `[${label}] ${text}` : `[${label}]`;
}

export function buildTranscript(
  messages: { source: Source; sentAt: number; type: string; text?: string }[],
): string {
  return [...messages]
    .sort((a, b) => a.sentAt - b.sentAt)
    .map((m) => `[${clock(m.sentAt)}] ${LABELS[m.source]}: ${contentOf(m)}`)
    .join("\n");
}
