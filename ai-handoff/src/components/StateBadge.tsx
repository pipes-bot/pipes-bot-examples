import { Badge } from "@/components/ui/badge";
import type { Mode } from "../../convex/lib/handoff";

const LABELS: Record<Mode, string> = { ai: "AI", human: "With staff", waiting_human: "Needs human" };
const VARIANTS = { ai: "secondary", human: "outline", waiting_human: "destructive" } as const;

export function StateBadge({ mode }: { mode: Mode }) {
  return <Badge variant={VARIANTS[mode]}>{LABELS[mode]}</Badge>;
}
