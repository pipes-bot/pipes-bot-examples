import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import type { Doc } from "../../convex/_generated/dataModel";

const SOURCE_LABELS = { customer: "Customer", ai: "AI", phone: "Staff (phone)" } as const;

/** Message text is always rendered as a React text node, never as HTML. */
export function MessageBubble({ message }: { message: Doc<"messages"> }) {
  const outgoing = message.direction === "out";
  const failed = message.status === "failed";
  return (
    <div className={cn("flex flex-col gap-1", outgoing ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
          outgoing ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {message.text ?? `[${message.type}]`}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">{SOURCE_LABELS[message.source]}</span>
        <span>{formatDateTime(message.sentAt)}</span>
        {outgoing && (
          <span className={cn(failed && "text-destructive")} title={message.error}>
            {message.status}
          </span>
        )}
      </div>
    </div>
  );
}
