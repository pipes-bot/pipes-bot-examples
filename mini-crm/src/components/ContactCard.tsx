import { Link } from "@tanstack/react-router";
import { ArrowRightLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { STAGE_LABELS, contactLabel, formatAgo } from "@/lib/format";
import type { ContactSummary } from "../../convex/crmRead";
import { STAGES, type Stage } from "../../convex/lib/crm";

/** dataTransfer type for a dragged card; the payload is the contact id. */
export const CONTACT_DRAG_TYPE = "application/x-mini-crm-contact";

export function ContactCard({
  contact,
  now,
  onMove,
}: {
  contact: ContactSummary;
  now: number;
  onMove: (stage: Stage) => void;
}) {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(CONTACT_DRAG_TYPE, contact.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      className="relative cursor-grab rounded-lg border bg-card p-3 text-card-foreground shadow-xs transition-colors hover:border-foreground/20 active:cursor-grabbing"
    >
      <div className="flex items-start gap-2">
        {/* The link covers the whole card (after:inset-0), so a click anywhere opens the conversation. */}
        <Link
          to="/inbox/$contactId"
          params={{ contactId: contact.id }}
          draggable={false}
          className="min-w-0 flex-1 truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
        >
          {contactLabel(contact)}
        </Link>
        <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
          {formatAgo(contact.lastMessageAt, now)}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="relative z-10 -mt-0.5 -mr-1 text-muted-foreground"
              aria-label="Move to…"
              title="Move to…"
            >
              <ArrowRightLeft />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Move to…</DropdownMenuLabel>
            {STAGES.filter((stage) => stage !== contact.stage).map((stage) => (
              <DropdownMenuItem key={stage} onSelect={() => onMove(stage)}>
                {STAGE_LABELS[stage]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {contact.lastPreview && (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{contact.lastPreview}</p>
      )}
      {(contact.waitingForReply || contact.pendingDrafts > 0 || contact.tags.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {contact.waitingForReply && <WaitingBadge />}
          {contact.pendingDrafts > 0 && <DraftsBadge count={contact.pendingDrafts} />}
          {contact.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function WaitingBadge() {
  return (
    <Badge variant="outline">
      <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
      Waiting for reply
    </Badge>
  );
}

export function DraftsBadge({ count }: { count: number }) {
  return <Badge variant="outline">{count === 1 ? "1 draft" : `${count} drafts`}</Badge>;
}
