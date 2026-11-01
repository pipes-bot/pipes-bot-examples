import { useAction } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage, formatDateTime, formatAgo, sendFailure } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";

export type ConversationMessage = Doc<"messages"> & { from: string };

/** Who sent an outgoing message: from this app, from the WhatsApp Business app, or an MCP client. */
function sourceLabel(message: ConversationMessage): string {
  switch (message.source) {
    case "app":
      return "You";
    case "phone":
      return "Phone";
    default:
      return `via ${message.clientName ?? "MCP"}`;
  }
}

function body(message: ConversationMessage): string {
  if (message.type === "text") return message.text ?? "";
  return message.text ? `[${message.type}] ${message.text}` : `[${message.type}]`;
}

export function MessageBubble({ message, now }: { message: ConversationMessage; now: number }) {
  const outgoing = message.direction === "out";
  const retry = useAction(api.sending.retry);
  const [retrying, setRetrying] = useState(false);

  async function onRetry() {
    setRetrying(true);
    try {
      const result = await retry({ messageId: message._id });
      if (result.status === "failed") toast.error(sendFailure(result.error));
      if (result.status === "queued") toast("Rate limited. The message is queued and will go out shortly.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-1", outgoing ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
          outgoing ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted",
          message.status === "failed" && "bg-destructive/10 text-foreground",
        )}
      >
        {body(message)}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground">
        {outgoing && <Badge variant="outline">{sourceLabel(message)}</Badge>}
        <time dateTime={new Date(message.sentAt).toISOString()} title={formatDateTime(message.sentAt)}>
          {formatAgo(message.sentAt, now)}
        </time>
        {outgoing && (
          <span className={message.status === "failed" ? "text-destructive" : undefined}>
            · {message.status}
          </span>
        )}
      </div>
      {outgoing && message.status === "failed" && (
        <div className="flex max-w-[80%] items-center gap-2 px-1 text-xs">
          <span className="text-destructive">{sendFailure(message.error)}</span>
          {message.retriedBy === undefined ? (
            <Button size="xs" variant="outline" disabled={retrying} onClick={() => void onRetry()}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          ) : (
            <span className="text-muted-foreground">Retried</span>
          )}
        </div>
      )}
    </div>
  );
}
