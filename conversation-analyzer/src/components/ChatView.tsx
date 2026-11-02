import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import type { Doc } from "../../convex/_generated/dataModel";

type Message = Doc<"messages">;

function bodyOf(message: Message): string {
  if (message.source === "api" && !message.text) return "Sent via API (content not available)";
  if (message.type === "text") return message.text ?? "";
  if (message.type === "media_placeholder") return "[media]";
  return message.text ? `[${message.type}] ${message.text}` : `[${message.type}]`;
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function Ticks({ message }: { message: Message }) {
  if (message.failedAt !== undefined) {
    return <span className="text-destructive">Failed</span>;
  }
  if (message.readAt !== undefined) {
    return <span title="Read">✓✓ Read</span>;
  }
  if (message.deliveredAt !== undefined) {
    return <span title="Delivered">✓✓ Delivered</span>;
  }
  return <span title="Sent">✓ Sent</span>;
}

export function ChatView({ messages }: { messages: Message[] }) {
  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground">No messages.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {messages.map((message) => {
        const fromCustomer = message.source === "customer";
        return (
          <li
            key={message._id}
            className={cn("flex", fromCustomer ? "justify-start" : "justify-end")}
          >
            <div
              className={cn(
                "max-w-[80%] space-y-1 rounded-lg px-3 py-2 text-sm",
                fromCustomer ? "bg-muted" : "bg-primary/10",
              )}
            >
              {!fromCustomer && (
                <Badge variant="secondary">{message.source === "api" ? "API" : "phone"}</Badge>
              )}
              <p className="whitespace-pre-wrap break-words">{bodyOf(message)}</p>
              <p className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <time dateTime={new Date(message.sentAt).toISOString()}>{time(message.sentAt)}</time>
                {!fromCustomer && <Ticks message={message} />}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
