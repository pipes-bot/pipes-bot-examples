import { ConvexError } from "convex/values";
import { useEffect, useState } from "react";

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". Times in the future count as "just now". */
export function relativeTime(ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

type ResumeRow = { mode: "ai" | "human" | "waiting_human"; resumeAt?: number };

/** Plain-language line about when the AI answers again. */
export function resumeLabel(row: ResumeRow, now: number): string {
  if (row.mode === "waiting_human") return "Waiting for your team";
  if (row.mode === "ai") return "AI is answering";
  if (row.resumeAt !== undefined && row.resumeAt > now) {
    return `AI back in ${Math.ceil((row.resumeAt - now) / 60_000)} min`;
  }
  return "AI resumes on the next message";
}

/** Convex user-facing errors carry their message in `data`. */
export function errorMessage(error: unknown): string {
  return error instanceof ConvexError ? String(error.data) : "Something went wrong";
}

/** Re-renders every `intervalMs` and returns the current time, fresh on every render. */
export function useNow(intervalMs = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return Date.now();
}
