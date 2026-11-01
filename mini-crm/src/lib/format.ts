import { ConvexError } from "convex/values";
import { useEffect, useState } from "react";
import type { Stage, Window } from "../../convex/lib/crm";
import { sendErrorMessage } from "../../convex/lib/send";

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * DAY],
  ["month", 30 * DAY],
  ["week", 7 * DAY],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "5 minutes ago", "in 3 hours", "yesterday". Truncates, so "in 23 hours" never overstates. */
export function formatRelative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return diff > 0 ? "in less than a minute" : "just now";
  for (const [unit, size] of UNITS) {
    if (abs >= size) return relative.format(Math.trunc(diff / size), unit);
  }
  return "just now"; // unreachable: the last unit is a minute
}

/** For things that already happened: a server clock slightly ahead never reads as the future. */
export function formatAgo(ms: number, now: number): string {
  return formatRelative(Math.min(ms, now), now);
}

export function errorMessage(error: unknown): string {
  return error instanceof ConvexError ? String(error.data) : "Something went wrong";
}

/** Text for a failed SendResult. A lost approval race returns a sentence, not a code. */
export function sendFailure(error: string | undefined): string {
  if (error === undefined) return "Sending failed.";
  return error.includes(" ") ? error : sendErrorMessage(error);
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The 24h window as of `now`. Queries compute `open` when they run, so a page left open would keep
 * showing a window that has since closed; `closesAt` does not go stale.
 */
export function liveWindow(window: Window, now: number): Window {
  return window.closesAt === undefined ? { open: false } : { open: now < window.closesAt, closesAt: window.closesAt };
}

export const STAGE_LABELS: Record<Stage, string> = {
  lead: "Lead",
  qualified: "Qualified",
  customer: "Customer",
  lost: "Lost",
};

export function contactLabel(contact: { name?: string; phone?: string; userId?: string }): string {
  if (contact.name) return contact.name;
  if (contact.phone) return `+${contact.phone}`;
  return contact.userId ?? "Unknown contact";
}
