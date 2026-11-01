import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/inbox")({
  component: () => <h1 className="text-xl font-semibold">Inbox</h1>,
});
