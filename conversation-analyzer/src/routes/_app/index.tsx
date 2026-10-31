import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { StatCards } from "@/components/StatCards";
import { WaitingList } from "@/components/WaitingList";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "../../../convex/_generated/api";

export const Route = createFileRoute("/_app/")({
  component: Overview,
});

function Overview() {
  const numbers = useQuery(api.numbers.list);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>
      {numbers === undefined ? null : numbers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No numbers yet</CardTitle>
            <CardDescription>
              Connect a WhatsApp Business number to start tracking conversations.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <Link to="/numbers" className="font-medium underline">
                Go to Numbers
              </Link>{" "}
              to connect one.
            </p>
            <p className="text-muted-foreground">
              No phone at hand? Seed demo conversations with the demo seed command in the README:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                npx convex run demo:seed &apos;{`{"email":"you@example.com"}`}&apos;
              </code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <StatCards />
          <WaitingList />
        </>
      )}
    </div>
  );
}
