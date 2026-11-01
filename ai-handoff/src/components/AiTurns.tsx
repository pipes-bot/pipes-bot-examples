import { useQuery } from "convex/react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDateTime } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

export function AiTurns({ conversationId }: { conversationId: Id<"conversations"> }) {
  const runs = useQuery(api.conversations.aiRuns, { conversationId });
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full justify-between">
          <span>AI turns{runs !== undefined && ` (${runs.length})`}</span>
          <ChevronDown className="size-4" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t p-4">
          {runs === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
          {runs?.length === 0 && <p className="text-sm text-muted-foreground">The AI has not run yet.</p>}
          {runs?.map((run) => (
            <div key={run._id} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={run.outcome === "error" ? "destructive" : "secondary"}>{run.outcome}</Badge>
                {run.dropReason && <Badge variant="outline">{run.dropReason}</Badge>}
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(run.startedAt)} · {((run.finishedAt - run.startedAt) / 1000).toFixed(1)} s ·{" "}
                  {run.model}
                </span>
              </div>
              {run.toolCalls.map((call, i) => (
                <p key={i} className="font-mono text-xs break-all">
                  {call.name}({JSON.stringify(call.args)})
                </p>
              ))}
              {run.replyPreview && <p className="whitespace-pre-wrap break-words">{run.replyPreview}</p>}
              {run.error && <p className="text-destructive break-words">{run.error}</p>}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
