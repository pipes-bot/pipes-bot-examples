import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">mini-crm</h1>
    </main>
  ),
});
