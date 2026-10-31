import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type EditableStep = { key: string; id?: string; name: string; description: string };

export function MethodologyEditor({
  steps,
  onChange,
}: {
  steps: EditableStep[];
  onChange: (steps: EditableStep[]) => void;
}) {
  function update(index: number, patch: Partial<EditableStep>) {
    onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {steps.map((step, index) => (
        <div key={step.key} className="space-y-2 rounded-lg border p-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor={`step-name-${step.key}`}>Step {index + 1} name</Label>
              <Input
                id={`step-name-${step.key}`}
                value={step.name}
                onChange={(event) => update(index, { name: event.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Move step ${index + 1} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Move step ${index + 1} down`}
              disabled={index === steps.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Remove step ${index + 1}`}
              onClick={() => onChange(steps.filter((_, i) => i !== index))}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`step-description-${step.key}`}>Description</Label>
            <Textarea
              id={`step-description-${step.key}`}
              value={step.description}
              onChange={(event) => update(index, { description: event.target.value })}
            />
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          onChange([...steps, { key: crypto.randomUUID(), name: "", description: "" }])
        }
      >
        <Plus /> Add step
      </Button>
      <p className="text-sm text-muted-foreground">
        Changes apply to conversations analyzed from now on. Use Re-analyze on a conversation to
        score it again.
      </p>
    </div>
  );
}
