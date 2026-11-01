import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { conversationTitle } from "@/components/ConversationList";
import { StateBadge } from "@/components/StateBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { errorMessage, resumeLabel } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { reasonLabel, type HandoffReason, type Mode, type Window } from "../../convex/lib/handoff";

type Props = {
  conversation: {
    id: Id<"conversations">;
    name?: string;
    phone?: string;
    mode: Mode;
    handoffReason?: HandoffReason;
    handoffSummary?: string;
    resumeAt?: number;
    lastError?: string;
    window: Window;
  };
  now: number;
};

export function ConversationHeader({ conversation, now }: Props) {
  const takeOver = useMutation(api.conversations.takeOver);
  const handBack = useMutation(api.conversations.handBack);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const conversationId = conversation.id;
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{conversationTitle(conversation)}</h1>
        <StateBadge mode={conversation.mode} />
        <div className="ml-auto flex gap-2">
          {conversation.mode !== "human" && (
            <Button variant="outline" disabled={busy} onClick={() => run(() => takeOver({ conversationId }))}>
              Take over
            </Button>
          )}
          {conversation.mode !== "ai" && (
            <Button disabled={busy} onClick={() => run(() => handBack({ conversationId }))}>
              Hand back to AI
            </Button>
          )}
        </div>
      </div>
      {conversation.name && conversation.phone && (
        <p className="text-sm text-muted-foreground">{conversation.phone}</p>
      )}
      {conversation.handoffReason && <p className="text-sm">{reasonLabel(conversation.handoffReason)}</p>}
      {conversation.handoffSummary && (
        <Alert>
          <AlertDescription>{conversation.handoffSummary}</AlertDescription>
        </Alert>
      )}
      {conversation.lastError && (
        <Alert variant="destructive">
          <AlertDescription>{conversation.lastError}</AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">{resumeLabel(conversation, now)}</p>
      {!conversation.window.open && (
        <p className="text-sm text-muted-foreground">
          The 24-hour window is closed, so the AI cannot reply until the customer writes again.
        </p>
      )}
    </header>
  );
}
