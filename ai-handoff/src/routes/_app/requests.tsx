import { createFileRoute } from "@tanstack/react-router";

// Placeholder: the requests page replaces this one.
export const Route = createFileRoute("/_app/requests")({
  component: () => <h1 className="text-xl font-semibold">Requests</h1>,
});
