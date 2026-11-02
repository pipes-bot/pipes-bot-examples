import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";
import { ConversationLink } from "@/components/ConversationLink";
import { HealthBadge } from "@/components/HealthBadge";
import { ImportCard } from "@/components/ImportCard";
import { StatCards } from "@/components/StatCards";
import { WaitingList } from "@/components/WaitingList";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatDuration } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export const Route = createFileRoute("/_app/numbers/$numberId")({
  component: NumberPage,
  errorComponent: NumberNotFound,
});

function NumberNotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">Number not found</h1>
      <Link to="/numbers" className="text-sm font-medium underline">
        Back to Numbers
      </Link>
    </div>
  );
}

function NumberPage() {
  const numberId = Route.useParams().numberId as Id<"numbers">;
  const number = useQuery(api.numbers.get, { numberId });
  const [status, setStatus] = useState<"open" | "closed">("open");
  const conversations = useQuery(api.dashboard.conversations, { numberId, status });

  if (number === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link to="/numbers" className="text-sm text-muted-foreground hover:underline">
          Numbers
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{number.displayName}</h1>
          <HealthBadge health={number.health} />
        </div>
        <p className="text-sm text-muted-foreground">
          {number.phoneNumber} · connected {formatDateTime(number.connectedAt)}
        </p>
      </header>

      <ImportCard numberId={numberId} />
      <StatCards numberId={numberId} />
      <WaitingList numberId={numberId} />

      <section className="space-y-3">
        <Tabs
          value={status}
          onValueChange={(value) => setStatus(value === "closed" ? "closed" : "open")}
        >
          <TabsList>
            <TabsTrigger value="open">Open</TabsTrigger>
            <TabsTrigger value="closed">Closed</TabsTrigger>
          </TabsList>
        </Tabs>
        {conversations === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {status} conversations.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contact</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead>First response</TableHead>
                <TableHead>Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conversations.map((conversation) => (
                <TableRow key={conversation._id}>
                  <TableCell>
                    <ConversationLink conversationId={conversation._id}>
                      <span className="font-medium">
                        {conversation.contactName ?? conversation.contactLabel}
                      </span>
                    </ConversationLink>
                    {conversation.imported && (
                      <Badge variant="secondary" className="ml-2">
                        Imported
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(conversation.lastActivityAt)}</TableCell>
                  <TableCell>{formatDuration(conversation.metrics?.firstResponseSeconds)}</TableCell>
                  <TableCell>
                    {conversation.score !== undefined ? (
                      <span className="tabular-nums">{conversation.score}</span>
                    ) : conversation.analysisState ? (
                      <Badge variant="secondary">{conversation.analysisState}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
