import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { errorMessage, formatDateTime } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";

type Props = {
  request: Doc<"requests">;
  conversationName?: string;
  phone?: string;
};

export function RequestCard({ request, conversationName, phone }: Props) {
  const markDone = useMutation(api.requests.markDone);
  const [busy, setBusy] = useState(false);
  const customer = request.customerName || conversationName || phone;

  async function done() {
    setBusy(true);
    try {
      await markDone({ requestId: request._id });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-start gap-2">
          <h2 className="font-medium break-words">{request.summary}</h2>
          {request.status === "open" && (
            <Button size="sm" className="ml-auto" disabled={busy} onClick={done}>
              Mark done
            </Button>
          )}
        </div>
        {request.details && <p className="text-sm whitespace-pre-wrap break-words">{request.details}</p>}
        <p className="text-xs text-muted-foreground">
          {customer && <>{customer} · </>}
          {formatDateTime(request.createdAt)} ·{" "}
          <Link
            to="/conversations/$conversationId"
            params={{ conversationId: request.conversationId }}
            className="underline"
          >
            View conversation
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
