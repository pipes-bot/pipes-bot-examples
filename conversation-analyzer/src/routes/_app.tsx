import { Link, Navigate, Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../../convex/_generated/api";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/sign-in" />;
  return <SignedInShell />;
}

function SignedInShell() {
  const ensureWorkspace = useMutation(api.workspaces.ensureWorkspace);
  const navigate = useNavigate();

  useEffect(() => {
    void ensureWorkspace();
  }, [ensureWorkspace]);

  async function signOut() {
    await authClient.signOut();
    await navigate({ to: "/sign-in" });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <nav className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 text-sm">
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "font-medium" }}>
            Overview
          </Link>
          {/* /numbers and /settings are added in later tasks, so the typed route tree lacks them. */}
          <Link to={"/numbers" as "/"} activeProps={{ className: "font-medium" }}>
            Numbers
          </Link>
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
