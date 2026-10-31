import { Link, createFileRoute, type ErrorComponentProps } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ChatView } from "@/components/ChatView";
import { StepList } from "@/components/StepList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage, formatDateTime, formatDuration } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";

export const Route = createFileRoute("/_app/conversations/$conversationId")({
  component: ConversationPage,
  errorComponent: ConversationError,
});

function ConversationError({ error }: ErrorComponentProps) {
  const notFound = error instanceof ConvexError && error.data === "Not found";
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">
        {notFound ? "Conversation not found" : "Something went wrong"}
      </h1>
      <Link to="/numbers" className="text-sm font-medium underline">
        Back to Numbers
      </Link>
    </div>
  );
}

type Conversation = Doc<"conversations">;

function ConversationPage() {
  const conversationId = Route.useParams().conversationId as Id<"conversations">;
  const data = useQuery(api.dashboard.conversation, { conversationId });

  if (data === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { conversation, contact, number, messages } = data;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link
          to="/numbers/$numberId"
          params={{ numberId: number._id }}
          className="text-sm text-muted-foreground hover:underline"
        >
          {number.displayName}
        </Link>
        <h1 className="text-xl font-semibold">
          {contact?.name ?? contact?.waId ?? contact?.userId ?? "Unknown contact"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {conversation.status === "open" ? "Open" : "Closed"} · opened{" "}
          {formatDateTime(conversation.openedAt)}
        </p>
      </header>
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <ChatView messages={messages} />
        <aside className="space-y-4">
          <MetricsCard conversation={conversation} />
          <AnalysisCard conversationId={conversationId} conversation={conversation} />
        </aside>
      </div>
    </div>
  );
}

function MetricsCard({ conversation }: { conversation: Conversation }) {
  const metrics = conversation.metrics;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Metrics</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Initiated by</dt>
          <dd>{conversation.initiatedBy}</dd>
          <dt className="text-muted-foreground">First response</dt>
          <dd>{formatDuration(metrics?.firstResponseSeconds)}</dd>
          <dt className="text-muted-foreground">Avg response</dt>
          <dd>{formatDuration(metrics?.avgResponseSeconds)}</dd>
          <dt className="text-muted-foreground">Max response</dt>
          <dd>{formatDuration(metrics?.maxResponseSeconds)}</dd>
          <dt className="text-muted-foreground">Unanswered turns</dt>
          <dd>{metrics?.unansweredTurns ?? "—"}</dd>
          <dt className="text-muted-foreground">Duration</dt>
          <dd>{formatDuration(metrics?.durationSeconds)}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

function AnalysisCard({
  conversationId,
  conversation,
}: {
  conversationId: Id<"conversations">;
  conversation: Conversation;
}) {
  const retryAnalysis = useMutation(api.conversations.retryAnalysis);
  const reanalyze = useMutation(api.conversations.reanalyze);
  const [busy, setBusy] = useState(false);
  const analysis = conversation.analysis;

  async function run(action: typeof retryAnalysis) {
    setBusy(true);
    try {
      await action({ conversationId });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Analysis</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {analysis === undefined ? (
          <p className="text-muted-foreground">
            {conversation.status === "open"
              ? "Analysis starts when the conversation closes."
              : "No analysis yet."}
          </p>
        ) : analysis.state === "pending" || analysis.state === "running" ? (
          <p className="flex items-center gap-2 text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            {analysis.state === "pending" ? "Waiting to analyze…" : "Analyzing…"}
          </p>
        ) : analysis.state === "failed" ? (
          <div className="space-y-2">
            <p className="text-destructive">Analysis failed{analysis.reason ? `: ${analysis.reason}` : "."}</p>
            <Button size="sm" disabled={busy} onClick={() => run(retryAnalysis)}>
              Retry
            </Button>
          </div>
        ) : analysis.state === "skipped" ? (
          <p className="text-muted-foreground">
            {analysis.reason === "no-api-key"
              ? "Set OPENROUTER_API_KEY to enable analysis"
              : "No reply to evaluate"}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Score</span>
              <Badge variant="secondary">
                {analysis.score !== undefined ? `${analysis.score}%` : "—"}
              </Badge>
            </div>
            {analysis.summary && <p>{analysis.summary}</p>}
            {analysis.steps && (
              <StepList steps={analysis.steps} methodology={analysis.methodology} />
            )}
          </div>
        )}
        {conversation.status === "closed" && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || analysis?.state === "pending" || analysis?.state === "running"}
            onClick={() => run(reanalyze)}
          >
            Re-analyze
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
