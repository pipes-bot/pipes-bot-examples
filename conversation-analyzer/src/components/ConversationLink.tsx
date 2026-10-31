import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Id } from "../../convex/_generated/dataModel";

// TODO(Task 12): the conversation route does not exist yet, so the typed route tree rejects it.
export function ConversationLink({
  conversationId,
  children,
}: {
  conversationId: Id<"conversations">;
  children: ReactNode;
}) {
  return (
    <Link to={`/conversations/${conversationId}` as "/"} className="hover:underline">
      {children}
    </Link>
  );
}
