import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { AiTurns } from "@/components/AiTurns";
import { ChatView } from "@/components/ChatView";
import { ConversationHeader } from "@/components/ConversationHeader";
import { Simulator } from "@/components/Simulator";
import { useNow } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export const Route = createFileRoute("/_app/conversations/$conversationId")({
  component: ConversationPage,
});

function ConversationPage() {
  const { conversationId } = Route.useParams();
  const id = conversationId as Id<"conversations">;
  const now = useNow(30_000);
  const data = useQuery(api.conversations.get, { conversationId: id });

  return (
    <div className="space-y-4">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ArrowLeft className="size-4" /> Conversations
      </Link>
      {data === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && (
        <>
          <ConversationHeader conversation={data.conversation} now={now} />
          <ChatView messages={data.messages} />
          {data.conversation.isDemo && <Simulator conversationId={id} />}
          <AiTurns conversationId={id} />
        </>
      )}
    </div>
  );
}
