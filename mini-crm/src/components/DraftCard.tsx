import { useAction, useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, formatAgo, sendFailure } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";

const MAX_TEXT = 4096;

/** A reply an MCP client prepared in draft mode. It goes out only when someone clicks Send. */
export function DraftCard({
  draft,
  windowOpen,
  now,
}: {
  draft: Doc<"drafts">;
  windowOpen: boolean;
  now: number;
}) {
  const approve = useAction(api.drafts.approve);
  const discard = useMutation(api.drafts.discard);
  const [text, setText] = useState(draft.text);
  const [pending, setPending] = useState<"send" | "discard">();

  async function onSend() {
    setPending("send");
    try {
      const result = await approve({ draftId: draft._id, text });
      if (result.status === "failed") toast.error(sendFailure(result.error));
      if (result.status === "queued") toast("Rate limited. The message is queued and will go out shortly.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(undefined);
    }
  }

  async function onDiscard() {
    setPending("discard");
    try {
      await discard({ draftId: draft._id });
    } catch (error) {
      toast.error(errorMessage(error));
      setPending(undefined);
    }
  }

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Draft via {draft.clientName}</span>
        <span>{formatAgo(draft.createdAt, now)}</span>
      </div>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={MAX_TEXT}
        aria-label={`Draft from ${draft.clientName}`}
        className="min-h-16 bg-background"
      />
      {!windowOpen && (
        <p className="mt-2 text-xs text-destructive">
          The 24-hour window is closed, so this draft can't be sent. WhatsApp only allows a free-form
          reply within 24 hours of the contact's last message.
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={pending !== undefined} onClick={() => void onDiscard()}>
          {pending === "discard" ? "Discarding…" : "Discard"}
        </Button>
        <Button
          size="sm"
          disabled={!windowOpen || pending !== undefined || text.trim().length === 0}
          onClick={() => void onSend()}
        >
          {pending === "send" ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
