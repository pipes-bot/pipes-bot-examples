import { useAction } from "convex/react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, formatDateTime, formatRelative, sendFailure } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Window } from "../../convex/lib/crm";

const MAX_TEXT = 4096;

export function Composer({
  contactId,
  replyWindow,
  now,
}: {
  contactId: Id<"contacts">;
  replyWindow: Window;
  now: number;
}) {
  const send = useAction(api.sending.send);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function submit() {
    if (!replyWindow.open || sending || text.trim().length === 0) return;
    setSending(true);
    try {
      const result = await send({ contactId, text });
      if (result.status === "failed") {
        toast.error(sendFailure(result.error));
        // Refused before anything was written: keep the text so it can be sent later.
        if (result.messageId === undefined) return;
      }
      if (result.status === "queued") toast("Rate limited. The message is queued and will go out shortly.");
      setText("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={!replyWindow.open}
        maxLength={MAX_TEXT}
        placeholder={replyWindow.open ? "Write a reply…" : "Replies are disabled while the window is closed"}
        aria-label="Reply"
        className="min-h-16"
      />
      <div className="flex items-start justify-between gap-4">
        <WindowNote replyWindow={replyWindow} now={now} />
        <Button type="submit" size="sm" disabled={!replyWindow.open || sending || text.trim().length === 0}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}

function WindowNote({ replyWindow, now }: { replyWindow: Window; now: number }) {
  if (replyWindow.open && replyWindow.closesAt !== undefined) {
    return (
      <p className="pt-1 text-xs text-muted-foreground" title={formatDateTime(replyWindow.closesAt)}>
        Window closes {formatRelative(replyWindow.closesAt, now)}
      </p>
    );
  }
  const why =
    "WhatsApp only allows a free-form reply within 24 hours of the contact's last message. You can reply again after they write to you.";
  if (replyWindow.closesAt === undefined) {
    return (
      <p className="pt-1 text-xs text-muted-foreground">
        This contact hasn't written to you yet, so the 24-hour window is not open. {why}
      </p>
    );
  }
  return (
    <p className="pt-1 text-xs text-muted-foreground">
      The 24-hour window closed {formatRelative(replyWindow.closesAt, now)} ({formatDateTime(replyWindow.closesAt)}).{" "}
      {why}
    </p>
  );
}
