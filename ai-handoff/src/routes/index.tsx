import { createFileRoute } from "@tanstack/react-router";

// Temporary placeholder, replaced by the real app shell.
export const Route = createFileRoute("/")({
  component: () => (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">AI handoff</h1>
    </main>
  ),
});
