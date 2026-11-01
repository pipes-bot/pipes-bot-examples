import { Outlet, createFileRoute } from "@tanstack/react-router";
import { InboxList } from "@/components/InboxList";

export const Route = createFileRoute("/_app/inbox")({
  component: Inbox,
});

function Inbox() {
  // Fills the viewport under the header; the list and the conversation scroll on their own.
  return (
    <div className="grid h-[calc(100dvh-6.5rem)] min-h-[28rem] overflow-hidden rounded-xl border md:grid-cols-[19rem_1fr]">
      <div className="hidden min-h-0 border-r md:flex md:flex-col">
        <InboxList />
      </div>
      <div className="min-h-0 min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
