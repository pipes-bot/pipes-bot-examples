import { Badge } from "@/components/ui/badge";
import type { Doc } from "../../convex/_generated/dataModel";

type Health = Doc<"numbers">["health"];

const LABELS = { healthy: "Healthy", unhealthy: "Unhealthy", unknown: "Unknown" } as const;
const VARIANTS = { healthy: "default", unhealthy: "destructive", unknown: "secondary" } as const;

export function HealthBadge({ health }: { health: Health }) {
  const state = health?.state ?? "unknown";
  return (
    <Badge variant={VARIANTS[state]} title={health?.detail}>
      {LABELS[state]}
    </Badge>
  );
}
