import { Badge } from "@/components/ui/badge";
import type { Doc } from "../../convex/_generated/dataModel";

type Health = Doc<"numbers">["health"];

const LABELS = { healthy: "Healthy", unhealthy: "Unhealthy", unknown: "Unknown" } as const;
const VARIANTS = { healthy: "default", unhealthy: "destructive", unknown: "secondary" } as const;

export function HealthBadge({ health }: { health: Health }) {
  const state = health?.state ?? "unknown";
  const title = [health?.canSendMessage && `Can send: ${health.canSendMessage}`, health?.detail]
    .filter(Boolean)
    .join(" · ");
  return (
    <Badge variant={VARIANTS[state]} title={title || undefined}>
      {LABELS[state]}
      {health?.canSendMessage ? ` · ${health.canSendMessage}` : ""}
    </Badge>
  );
}
