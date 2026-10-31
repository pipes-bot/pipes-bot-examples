import { Badge } from "@/components/ui/badge";
import type { Doc } from "../../convex/_generated/dataModel";

type Analysis = NonNullable<Doc<"conversations">["analysis"]>;

const LABELS = { met: "Met", not_met: "Not met", not_applicable: "N/A" } as const;
const VARIANTS = { met: "default", not_met: "destructive", not_applicable: "secondary" } as const;

export function StepList({
  steps,
  methodology,
}: {
  steps: NonNullable<Analysis["steps"]>;
  methodology: Analysis["methodology"];
}) {
  const names = new Map(methodology.map((step) => [step.id, step.name]));
  return (
    <ol className="space-y-3">
      {steps.map((step) => (
        <li key={step.stepId} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{names.get(step.stepId) ?? step.stepId}</span>
            <Badge variant={VARIANTS[step.verdict]}>{LABELS[step.verdict]}</Badge>
          </div>
          {step.evidence !== null && (
            <blockquote className="border-l-2 pl-2 text-sm italic text-muted-foreground">
              “{step.evidence}”
            </blockquote>
          )}
          <p className="text-sm text-muted-foreground">{step.reason}</p>
        </li>
      ))}
    </ol>
  );
}
