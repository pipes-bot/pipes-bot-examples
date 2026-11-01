import { Link } from "@tanstack/react-router";
import { StateBadge } from "@/components/StateBadge";
import { Badge } from "@/components/ui/badge";
import { relativeTime, resumeLabel } from "@/lib/format";
import type { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type ConversationRow = FunctionReturnType<typeof api.conversations.list>[number];

export function conversationTitle(row: { name?: string; phone?: string }): string {
  return row.name || row.phone || "Unknown customer";
}

export function ConversationList({ rows, now }: { rows: ConversationRow[]; now: number }) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No conversations yet. Connect a number or load demo data in Settings.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            to="/conversations/$conversationId"
            params={{ conversationId: row.id }}
            className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/50"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{conversationTitle(row)}</span>
              <StateBadge mode={row.mode} />
              {!row.aiEnabled && <Badge variant="outline">AI off</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">
                {relativeTime(row.lastMessageAt, now)}
              </span>
            </div>
            <p className="truncate text-sm text-muted-foreground">{row.lastPreview}</p>
            <p className="text-xs text-muted-foreground">
              {resumeLabel(row, now)}
              {row.numberName && <> · {row.numberName}</>}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
