import { Link, Navigate, Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../../convex/_generated/api";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function AppLayout() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return <FullPageSpinner />;
  if (!isAuthenticated) return <Navigate to="/sign-in" />;
  return <SignedInShell />;
}

function SignedInShell() {
  const ensureWorkspace = useMutation(api.workspaces.ensureWorkspace);
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  // ensureWorkspace is idempotent, so StrictMode's double effect run is harmless.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    ensureWorkspace().then(
      () => {
        if (!cancelled) setStatus("ready");
      },
      () => {
        if (!cancelled) setStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ensureWorkspace, attempt]);

  async function signOut() {
    await authClient.signOut();
    await navigate({ to: "/sign-in" });
  }

  if (status === "loading") return <FullPageSpinner />;
  if (status === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
        <p className="text-sm text-muted-foreground">We could not set up your workspace.</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <nav className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 text-sm">
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "font-medium" }}>
            Overview
          </Link>
          <Link to="/numbers" activeProps={{ className: "font-medium" }}>
            Numbers
          </Link>
          {/* TODO(Task 12): /settings is added later, so the typed route tree lacks it. */}
          <Link to={"/settings" as "/"} activeProps={{ className: "font-medium" }}>
            Settings
          </Link>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={signOut}>
            Sign out
          </Button>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl p-4">
        <Outlet />
      </main>
    </div>
  );
}
