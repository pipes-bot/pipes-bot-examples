import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  component: () => <h1 className="text-xl font-semibold">Overview</h1>,
});
