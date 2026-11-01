import { createFileRoute } from "@tanstack/react-router";

// Placeholder: the conversations list replaces this page.
export const Route = createFileRoute("/_app/")({
  component: () => <h1 className="text-xl font-semibold">Conversations</h1>,
});
