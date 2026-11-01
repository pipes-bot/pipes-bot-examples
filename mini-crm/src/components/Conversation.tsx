import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { Composer } from "@/components/Composer";
import { DraftCard } from "@/components/DraftCard";
import { MessageBubble } from "@/components/MessageBubble";
import { Badge } from "@/components/ui/badge";
import { STAGE_LABELS, contactLabel, liveWindow, useNow } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { ContactSummary } from "../../convex/crmRead";

export function Conversation({ contact }: { contact: ContactSummary }) {
  const contactId = contact.id;
  const conversation = useQuery(api.contacts.conversation, { contactId });
  const drafts = useQuery(api.drafts.pendingFor, { contactId });
  const markRead = useMutation(api.contacts.markRead);
  const now = useNow(30_000);
  const replyWindow = liveWindow(contact.window, now);
  const bottom = useRef<HTMLDivElement>(null);

  // `unread` grows with each inbound message, so this runs when the conversation opens with
  // something unread and again whenever a new message arrives while it is open.
  useEffect(() => {
    if (contact.unread > 0) void markRead({ contactId }).catch(() => {});
  }, [contactId, contact.unread, markRead]);

  const messages = conversation?.messages;
  const lastMessageId = messages?.at(-1)?._id;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId]);

  const label = contactLabel(contact);
  return (
    <section className="flex min-h-0 min-w-0 flex-col" aria-label={`Conversation with ${label}`}>
      <header className="flex items-center gap-2 border-b px-4 py-3">
        {/* The inbox list is hidden below `md`, so this is the way back to it. */}
        <Link
          to="/inbox"
          aria-label="Back to inbox"
          className="-ml-1 rounded-md p-1 text-muted-foreground hover:text-foreground md:hidden"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{label}</h1>
          {contact.name && contact.phone && (
            <p className="text-xs text-muted-foreground">+{contact.phone}</p>
          )}
        </div>
        <Badge variant="secondary" className="ml-auto">
          {STAGE_LABELS[contact.stage]}
        </Badge>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {conversation?.nextBefore !== undefined && (
              <p className="text-center text-xs text-muted-foreground">Showing the latest {messages.length} messages.</p>
            )}
            {messages.map((message) => (
              <MessageBubble key={message._id} message={message} now={now} />
            ))}
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="space-y-3 border-t p-4">
        {drafts !== undefined && drafts.length > 0 && (
          // Newest first. Capped so several drafts never push the conversation off screen.
          <div className="max-h-72 space-y-3 overflow-y-auto">
            {drafts.map((draft) => (
              <DraftCard key={draft._id} draft={draft} windowOpen={replyWindow.open} now={now} />
            ))}
          </div>
        )}
        <Composer contactId={contactId} replyWindow={replyWindow} now={now} />
      </div>
    </section>
  );
}
