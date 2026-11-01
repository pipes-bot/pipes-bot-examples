import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";
import { RequestCard } from "@/components/RequestCard";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "../../../convex/_generated/api";

export const Route = createFileRoute("/_app/requests")({
  component: RequestsPage,
});

function RequestsPage() {
  const [status, setStatus] = useState<"open" | "done">("open");
  const requests = useQuery(api.requests.list, { status });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Requests</h1>
      <Tabs value={status} onValueChange={(value) => setStatus(value as "open" | "done")}>
        <TabsList>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="done">Done</TabsTrigger>
        </TabsList>
      </Tabs>
      {requests === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
      {requests?.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {status === "open" ? "No open requests." : "No requests done yet."}
        </p>
      )}
      <div className="space-y-3">
        {requests?.map(({ request, conversationName, phone }) => (
          <RequestCard key={request._id} request={request} conversationName={conversationName} phone={phone} />
        ))}
      </div>
    </div>
  );
}
