import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ConversationList } from "@/components/ConversationList";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNow } from "@/lib/format";
import { api } from "../../../convex/_generated/api";

const TABS = ["needs_human", "with_staff", "ai", "all"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.find((t) => t === search.tab),
  }),
  component: ConversationsPage,
});

function ConversationsPage() {
  const tab = Route.useSearch().tab ?? "needs_human";
  const navigate = useNavigate({ from: Route.fullPath });
  const now = useNow(30_000);
  const rows = useQuery(api.conversations.list, { tab });
  const needsHuman = useQuery(api.conversations.list, { tab: "needs_human" });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Conversations</h1>
      <Tabs
        value={tab}
        onValueChange={(value) => navigate({ search: { tab: value as Tab } })}
      >
        <TabsList>
          <TabsTrigger value="needs_human">
            Needs human{needsHuman !== undefined && ` (${needsHuman.length})`}
          </TabsTrigger>
          <TabsTrigger value="with_staff">With staff</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>
      {rows === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ConversationList rows={rows} now={now} />
      )}
    </div>
  );
}
