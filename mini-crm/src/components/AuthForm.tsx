import { useNavigate } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

/** True when this page was opened by the OAuth provider (the query carries its signature). */
function hasOAuthQuery(): boolean {
  return new URLSearchParams(window.location.search).has("sig");
}

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { isAuthenticated } = useConvexAuth();
  const isSignUp = mode === "sign-up";
  const oauth = hasOAuthQuery();

  // Navigate only once Convex has the auth token, otherwise `_app` can see
  // "not authenticated" for a moment and bounce back to /sign-in. This also
  // redirects users who are already signed in. During an OAuth flow an already signed-in
  // user goes straight to the consent page with the same signed query (the authorize
  // request cannot carry the session, which lives in localStorage); `prompt=login` asks
  // for a fresh sign-in, so that one stays on the form.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!oauth) {
      void navigate({ to: "/" });
      return;
    }
    if (pending) return; // a submit in flight follows the redirect the provider returns
    const prompt = new URLSearchParams(window.location.search).get("prompt") ?? "";
    if (!prompt.split(" ").includes("login")) {
      window.location.replace(`/consent${window.location.search}`);
    }
  }, [isAuthenticated, pending, oauth, navigate]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "");
    setError(null);
    setPending(true);
    try {
      // oauthProviderClient() adds `oauth_query` from the page URL; the response is then
      // `{ redirect: true, url }` and the browser has to follow it to continue the flow.
      const result = isSignUp
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? "Something went wrong. Try again.");
        setPending(false);
        return;
      }
      const data = result.data as { redirect?: boolean; url?: string } | null;
      if (oauth && data?.redirect && data.url) {
        window.location.href = data.url;
      }
      // Otherwise stay pending until the effect above navigates.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setPending(false);
    }
  }

  // Keep the signed OAuth query when moving between sign-in and sign-up.
  const otherPage = `${isSignUp ? "/sign-in" : "/sign-up"}${oauth ? window.location.search : ""}`;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{isSignUp ? "Create your account" : "Sign in"}</CardTitle>
          <CardDescription>
            {isSignUp
              ? "Keep track of your WhatsApp contacts and conversations."
              : "Welcome back to Mini CRM."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {isSignUp && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" autoComplete="name" required />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                minLength={isSignUp ? 8 : undefined}
                required
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={pending}>
              {pending ? "Please wait..." : isSignUp ? "Create account" : "Sign in"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {isSignUp ? "Already have an account? " : "New here? "}
            {/* A plain anchor keeps the signed query byte for byte; the router would re-serialize it. */}
            <a href={otherPage} className="underline">
              {isSignUp ? "Sign in" : "Create an account"}
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
