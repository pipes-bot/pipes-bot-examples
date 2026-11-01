import { useEffect, useRef } from "react";
import { MessageBubble } from "@/components/MessageBubble";
import type { Doc } from "../../convex/_generated/dataModel";

export function ChatView({ messages }: { messages: Doc<"messages">[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [count]);

  if (count === 0) return <p className="text-sm text-muted-foreground">No messages yet.</p>;
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="chat">
      {messages.map((m) => (
        <MessageBubble key={m._id} message={m} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
