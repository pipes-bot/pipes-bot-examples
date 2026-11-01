import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useNow } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";

const TROUBLESHOOTING_AFTER_MS = 3 * 60 * 1000;

export const Route = createFileRoute("/_app/numbers/connected")({
  validateSearch: (search: Record<string, unknown>): { numberId?: string; phone?: string } => ({
    numberId: typeof search.numberId === "string" ? search.numberId : undefined,
    phone: typeof search.phone === "string" ? search.phone : undefined,
  }),
  component: Connected,
});

function Connected() {
  const { numberId, phone } = Route.useSearch();
  // `numberId` in the redirect URL is the pool number id from pipes.bot, not our table id.
  const number = useQuery(
    api.numbers.findByPoolNumberId,
    numberId ? { poolNumberId: numberId } : "skip",
  );
  const [startedAt] = useState(() => Date.now());
  const now = useNow(5000);

  if (number) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Connected</h1>
        <p className="text-sm">
          {number.displayName} ({number.phoneNumber}) is connected and ready to receive
          conversations.
        </p>
        <Link to="/numbers" className="text-sm font-medium underline">
          Back to Numbers
        </Link>
      </div>
    );
  }

  const slow = now - startedAt >= TROUBLESHOOTING_AFTER_MS;
  const webhookUrl = `${import.meta.env.VITE_CONVEX_SITE_URL ?? "https://<deployment>.convex.site"}/webhooks/pipes`;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Waiting for confirmation…</h1>
      <p className="text-sm text-muted-foreground">
        {phone
          ? `Waiting for ${phone} to be confirmed by pipes.bot.`
          : "Waiting for pipes.bot to confirm your number."}{" "}
        This page updates by itself.
      </p>
      {(slow || !numberId) && (
        <Alert>
          <AlertTitle>Taking longer than expected?</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                The App webhook URL must be <code>{webhookUrl}</code>.
              </li>
              <li>The App must be on API v2.</li>
              <li>
                The webhook signing secret must match <code>PIPES_WEBHOOK_SECRET</code> in your
                Convex environment.
              </li>
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <Link to="/numbers" className="text-sm font-medium underline">
        Back to Numbers
      </Link>
    </div>
  );
}
