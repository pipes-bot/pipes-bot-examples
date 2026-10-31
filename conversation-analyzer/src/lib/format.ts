import { ConvexError } from "convex/values";
import { useEffect, useState } from "react";

export function formatDuration(seconds?: number): string {
  if (seconds === undefined) return "—";
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatPercent(rate?: number): string {
  if (rate === undefined) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function errorMessage(error: unknown): string {
  return error instanceof ConvexError ? String(error.data) : "Something went wrong";
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
