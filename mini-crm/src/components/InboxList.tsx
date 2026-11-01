import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";
import { DraftsBadge, WaitingBadge } from "@/components/ContactCard";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { contactLabel, formatAgo, useNow } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { ContactSummary } from "../../convex/crmRead";

type Filter = "all" | "waiting" | "drafts";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting for reply" },
  { value: "drafts", label: "Has draft" },
];

export function InboxList() {
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow(30_000);
  // All three stay subscribed so each tab can show how many of its conversations are unread.
  const lists: Record<Filter, ContactSummary[] | undefined> = {
    all: useQuery(api.contacts.inbox, { filter: "all" }),
    waiting: useQuery(api.contacts.inbox, { filter: "waiting" }),
    drafts: useQuery(api.contacts.inbox, { filter: "drafts" }),
  };
  const contacts = lists[filter];

  return (
    <div className="flex min-h-0 flex-col">
      <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)} className="p-2">
        <TabsList className="w-full">
          {FILTERS.map(({ value, label }) => {
            const unread = lists[value]?.filter((contact) => contact.unread > 0).length ?? 0;
            return (
              <TabsTrigger key={value} value={value} className="text-xs">
                {label}
                {unread > 0 && (
                  <span
                    className="rounded-full bg-primary px-1.5 text-[0.65rem] leading-4 text-primary-foreground tabular-nums"
                    aria-label={`${unread} unread`}
                  >
                    {unread}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {contacts === undefined ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : contacts.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {filter === "all" ? "No conversations yet." : "Nothing here right now."}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 p-2 pt-0">
            {contacts.map((contact) => (
              <li key={contact.id}>
                <InboxRow contact={contact} now={now} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function InboxRow({ contact, now }: { contact: ContactSummary; now: number }) {
  return (
    <Link
      to="/inbox/$contactId"
      params={{ contactId: contact.id }}
      className="block rounded-lg px-3 py-2 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
      activeProps={{ className: "bg-muted" }}
    >
      <div className="flex items-center gap-2">
        <span className={contact.unread > 0 ? "truncate text-sm font-semibold" : "truncate text-sm font-medium"}>
          {contactLabel(contact)}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {formatAgo(contact.lastMessageAt, now)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <p className="truncate text-sm text-muted-foreground">{contact.lastPreview ?? "No messages"}</p>
        {contact.unread > 0 && (
          <span
            className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-[0.65rem] leading-4 text-primary-foreground tabular-nums"
            aria-label={`${contact.unread} unread`}
          >
            {contact.unread}
          </span>
        )}
      </div>
      {(contact.waitingForReply || contact.pendingDrafts > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {contact.waitingForReply && <WaitingBadge />}
          {contact.pendingDrafts > 0 && <DraftsBadge count={contact.pendingDrafts} />}
        </div>
      )}
    </Link>
  );
}
