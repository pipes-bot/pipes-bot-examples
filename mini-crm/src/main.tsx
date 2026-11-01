import { ConvexBetterAuthProvider, type AuthClient } from "@convex-dev/better-auth/react";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Toaster } from "./components/ui/sonner";
import { authClient } from "./lib/auth-client";
import { routeTree } from "./routeTree.gen";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// The provider's AuthClient type infers `useSession().data` as `never` with this better-auth
// version, so the real client is not assignable to it. The runtime shape is what the provider needs.
const providerAuthClient = authClient as unknown as AuthClient;

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL, { expectAuth: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexBetterAuthProvider client={convex} authClient={providerAuthClient}>
      <RouterProvider router={router} />
      <Toaster />
    </ConvexBetterAuthProvider>
  </StrictMode>,
);
