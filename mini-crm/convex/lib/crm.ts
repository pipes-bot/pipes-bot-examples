import { ConvexError } from "convex/values";

export type Stage = "lead" | "qualified" | "customer" | "lost";
export type Source = "contact" | "app" | "mcp" | "phone";
export type Window = { open: boolean; closesAt?: number };

export const STAGES: readonly Stage[] = ["lead", "qualified", "customer", "lost"];

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

export const WINDOW_MS = 86_400_000;

/** The 24h customer-service window: open iff the contact wrote less than 24h ago. */
export function windowState(contact: { lastInboundAt?: number }, now: number): Window {
  if (contact.lastInboundAt === undefined) return { open: false };
  const closesAt = contact.lastInboundAt + WINDOW_MS;
  return { open: now < closesAt, closesAt };
}

const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 20;

export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return tag.length === 0 || tag.length > MAX_TAG_LENGTH ? null : tag;
}

/** Applies removals, then additions, to a contact's tags. Nothing is written by the caller on error. */
export function normalizeTags(
  current: string[],
  add: string[] = [],
  remove: string[] = [],
): { tags: string[] } | { error: string } {
  const removed = new Set<string>();
  for (const raw of remove) {
    const tag = normalizeTag(raw);
    if (tag !== null) removed.add(tag);
  }
  const tags = new Set(current.filter((tag) => !removed.has(tag)));
  for (const raw of add) {
    const tag = normalizeTag(raw);
    if (tag === null) return { error: `Tag "${raw}" must be 1–${MAX_TAG_LENGTH} characters` };
    tags.add(tag);
  }
  if (tags.size > MAX_TAGS) return { error: `A contact can have at most ${MAX_TAGS} tags` };
  return { tags: [...tags] };
}

export function cleanText(raw: string, max: number, field: string): string {
  const text = raw.trim();
  if (text.length === 0 || text.length > max) {
    throw new ConvexError(`${field} must be 1–${max} characters`);
  }
  return text;
}

export function fromLabel(m: { source: Source; clientName?: string }): string {
  switch (m.source) {
    case "contact":
      return "contact";
    case "app":
      return "you";
    case "phone":
      return "phone";
    case "mcp":
      return m.clientName ?? "MCP";
  }
}

export function searchTextOf(c: { name?: string; waId?: string; userId?: string }): string {
  return [c.name, c.waId, c.userId].filter((v): v is string => v !== undefined).join(" ");
}

const PREVIEW_LENGTH = 120;

export function previewOf(m: { type: string; text?: string }): string {
  if (!m.text) return `[${m.type}]`;
  return m.text.length > PREVIEW_LENGTH ? `${m.text.slice(0, PREVIEW_LENGTH)}…` : m.text;
}
