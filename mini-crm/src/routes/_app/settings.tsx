import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/settings")({
  component: () => <h1 className="text-xl font-semibold">Settings</h1>,
});
