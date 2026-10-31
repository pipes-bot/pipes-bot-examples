import { useQuery } from "convex/react";
import { ConversationLink } from "@/components/ConversationLink";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDuration, useNow } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

export function WaitingList({ numberId }: { numberId?: Id<"numbers"> }) {
  const waiting = useQuery(api.dashboard.waiting, { numberId });
  const now = useNow();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Waiting for a reply</CardTitle>
      </CardHeader>
      <CardContent>
        {waiting === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">No customers are waiting right now.</p>
        ) : (
          <ul className="divide-y">
            {waiting.map((item) => (
              <li key={item.conversationId} className="flex items-baseline gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <ConversationLink conversationId={item.conversationId}>
                    <span className="font-medium">{item.contactName ?? item.contactId}</span>
                  </ConversationLink>
                  {item.lastMessage && (
                    <p className="truncate text-muted-foreground">{item.lastMessage}</p>
                  )}
                </div>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  waiting {formatDuration((now - item.waitingSince) / 1000)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
