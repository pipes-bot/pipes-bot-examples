import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Id } from "../../convex/_generated/dataModel";

export function ConversationLink({
  conversationId,
  children,
}: {
  conversationId: Id<"conversations">;
  children: ReactNode;
}) {
  return (
    <Link
      to="/conversations/$conversationId"
      params={{ conversationId }}
      className="hover:underline"
    >
      {children}
    </Link>
  );
}
