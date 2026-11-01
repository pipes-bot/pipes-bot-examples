import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ContactPanel } from "@/components/ContactPanel";
import { Conversation } from "@/components/Conversation";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export const Route = createFileRoute("/_app/inbox/$contactId")({
  component: ContactConversation,
  // contacts.detail throws "Not found" for a deleted contact (e.g. after a demo reset), one of
  // another workspace, or a malformed id.
  errorComponent: NotAvailable,
});

function ContactConversation() {
  const { contactId } = Route.useParams();
  const detail = useQuery(api.contacts.detail, { contactId: contactId as Id<"contacts"> });

  if (detail === undefined) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (detail === null) return <NotAvailable />;
  return (
    // Keyed so drafts, the composer and the name field start fresh for each contact.
    <div key={contactId} className="grid h-full min-h-0 lg:grid-cols-[1fr_18rem]">
      <Conversation contact={detail.contact} />
      <div className="hidden min-h-0 lg:flex lg:flex-col">
        <ContactPanel contact={detail.contact} notes={detail.notes} activities={detail.activities} />
      </div>
    </div>
  );
}

function NotAvailable() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
      <p>This conversation is not available.</p>
      <Link to="/inbox" className="underline underline-offset-4">
        Back to the inbox
      </Link>
    </div>
  );
}
