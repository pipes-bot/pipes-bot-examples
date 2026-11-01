import { createFileRoute } from "@tanstack/react-router";
import { InboxList } from "@/components/InboxList";

export const Route = createFileRoute("/_app/inbox/")({
  component: InboxIndex,
});

function InboxIndex() {
  return (
    <>
      {/* On narrow screens the layout hides its list column, so the list lives here instead. */}
      <div className="flex h-full flex-col md:hidden">
        <InboxList />
      </div>
      <div className="hidden h-full items-center justify-center text-sm text-muted-foreground md:flex">
        Select a conversation
      </div>
    </>
  );
}
