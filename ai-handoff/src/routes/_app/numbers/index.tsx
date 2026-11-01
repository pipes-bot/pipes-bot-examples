import { createFileRoute } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { HealthBadge } from "@/components/HealthBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { errorMessage, formatDateTime } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";

export const Route = createFileRoute("/_app/numbers/")({
  component: Numbers,
});

function Numbers() {
  const numbers = useQuery(api.numbers.list);
  const createSignupLink = useAction(api.numbers.createSignupLink);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  async function connect() {
    setConnecting(true);
    setError(undefined);
    try {
      const { url } = await createSignupLink();
      window.location.href = url;
    } catch (e) {
      setError(errorMessage(e));
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Numbers</h1>
        <Button onClick={connect} disabled={connecting}>
          {connecting ? "Opening…" : "Connect a number"}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {numbers === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : numbers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No numbers connected yet.</p>
      ) : (
        <div className="space-y-3">
          {numbers.map((number) => (
            <NumberRow key={number._id} number={number} />
          ))}
        </div>
      )}
    </div>
  );
}

function NumberRow({ number }: { number: Doc<"numbers"> }) {
  const setAiEnabled = useMutation(api.numbers.setAiEnabled);
  const [pending, setPending] = useState(false);
  const switchId = `ai-replies-${number._id}`;

  async function toggle(enabled: boolean) {
    setPending(true);
    try {
      await setAiEnabled({ numberId: number._id, enabled });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {number.displayName || number.phoneNumber || number.poolNumberId}
            </span>
            {number.isDemo && <Badge variant="secondary">Demo</Badge>}
            <HealthBadge health={number.health} />
          </div>
          <p className="text-sm text-muted-foreground">
            {number.phoneNumber} · Connected {formatDateTime(number.connectedAt)}
          </p>
        </div>
        <div className="flex items-start gap-3">
          <Switch
            id={switchId}
            checked={number.aiEnabled}
            disabled={pending}
            onCheckedChange={toggle}
          />
          <div className="space-y-0.5">
            <label htmlFor={switchId} className="text-sm font-medium">
              AI replies
            </label>
            <p className="text-xs text-muted-foreground">
              When on, the AI answers new customer messages on this number.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
