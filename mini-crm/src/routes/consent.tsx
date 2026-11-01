import { createFileRoute } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/consent")({
  component: Consent,
});

const SCOPE_COPY: Record<string, string> = {
  "crm:read": "Read your contacts and conversations",
  "crm:write": "Change contacts and send messages",
  offline_access: "Stay connected when you are away",
};

function Consent() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const search = new URLSearchParams(window.location.search);
  const clientId = search.get("client_id");
  const scopes = (search.get("scope") ?? "").split(" ").filter((scope) => scope in SCOPE_COPY);

  const [clientName, setClientName] = useState<string>();
  const [pending, setPending] = useState<"allow" | "deny">();
  const [error, setError] = useState<string>();

  // The consent endpoint needs the user's session. Go through sign-in and come back; a full
  // navigation keeps the signed query exactly as the provider issued it.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      window.location.replace(`/sign-in${window.location.search}`);
    }
  }, [isLoading, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !clientId) return;
    let cancelled = false;
    void authClient
      .$fetch<{ client_name?: string }>("/oauth2/public-client", { query: { client_id: clientId } })
      .then(({ data }) => {
        if (!cancelled && data?.client_name) setClientName(data.client_name);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, clientId]);

  async function decide(accept: boolean) {
    setPending(accept ? "allow" : "deny");
    setError(undefined);
    // oauthProviderClient() adds `oauth_query` from the page URL.
    const { data, error: failure } = await authClient.$fetch<{ redirect?: boolean; url?: string }>(
      "/oauth2/consent",
      { method: "POST", body: { accept } },
    );
    if (failure || !data?.url) {
      setError(failure?.message ?? "Could not complete the request. Start again from the app.");
      setPending(undefined);
      return;
    }
    window.location.href = data.url;
  }

  if (isLoading || !isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (!clientId || !search.has("sig")) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Alert variant="destructive" className="max-w-sm">
          <AlertDescription>This page is opened by an app asking for access. Start there.</AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{clientName ?? "An application"} wants access</CardTitle>
          <CardDescription>
            It will be able to use your Mini CRM workspace on your behalf.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {scopes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {scopes.map((scope) => (
                <li key={scope}>{SCOPE_COPY[scope]}</li>
              ))}
            </ul>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button className="flex-1" disabled={!!pending} onClick={() => void decide(true)}>
              {pending === "allow" ? "Please wait..." : "Allow"}
            </Button>
            <Button
              className="flex-1"
              variant="outline"
              disabled={!!pending}
              onClick={() => void decide(false)}
            >
              {pending === "deny" ? "Please wait..." : "Deny"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
