import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState, type DragEvent } from "react";
import { toast } from "sonner";
import { CONTACT_DRAG_TYPE, ContactCard } from "@/components/ContactCard";
import { cn } from "@/lib/utils";
import { STAGE_LABELS, errorMessage, useNow } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ContactSummary } from "../../convex/crmRead";
import { STAGES, type Stage } from "../../convex/lib/crm";

// contacts.pipeline returns at most this many contacts per stage.
const COLUMN_LIMIT = 100;

type Board = Record<Stage, ContactSummary[]>;

function findStage(board: Board, contactId: string): Stage | undefined {
  return STAGES.find((stage) => board[stage].some((contact) => contact.id === contactId));
}

export function PipelineBoard() {
  const board = useQuery(api.contacts.pipeline);
  const now = useNow(30_000);
  const [dropTarget, setDropTarget] = useState<Stage>();

  // Moves the card right away; Convex replaces this with the server result.
  const update = useMutation(api.contacts.update).withOptimisticUpdate((store, { contactId, stage }) => {
    const current = store.getQuery(api.contacts.pipeline, {});
    if (!current || stage === undefined) return;
    const from = findStage(current, contactId);
    if (from === undefined || from === stage) return;
    const moved = current[from].find((contact) => contact.id === contactId)!;
    store.setQuery(api.contacts.pipeline, {}, {
      ...current,
      [from]: current[from].filter((contact) => contact.id !== contactId),
      [stage]: [...current[stage], { ...moved, stage }].sort((a, b) => b.lastMessageAt - a.lastMessageAt),
    });
  });

  function move(contactId: Id<"contacts">, stage: Stage) {
    update({ contactId, stage }).catch((error: unknown) => toast.error(errorMessage(error)));
  }

  function onDrop(event: DragEvent, stage: Stage) {
    event.preventDefault();
    setDropTarget(undefined);
    const contactId = event.dataTransfer.getData(CONTACT_DRAG_TYPE);
    if (!board || !contactId || findStage(board, contactId) === stage) return;
    move(contactId as Id<"contacts">, stage);
  }

  if (board === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const empty = STAGES.every((stage) => board[stage].length === 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Pipeline</h1>
        {empty ? (
          <p className="text-sm text-muted-foreground">
            No contacts yet. Connect a number, or load demo data in{" "}
            <Link to="/settings" className="underline underline-offset-4">
              Settings
            </Link>
            .
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Drag a card to another column, or use its Move to… menu.
          </p>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {STAGES.map((stage) => {
          const contacts = board[stage];
          return (
            <section
              key={stage}
              aria-label={STAGE_LABELS[stage]}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(CONTACT_DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget(stage);
              }}
              onDragLeave={(event) => {
                // Leaving for a child element is not leaving the column.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropTarget((target) => (target === stage ? undefined : target));
                }
              }}
              onDrop={(event) => onDrop(event, stage)}
              className={cn(
                "flex min-h-40 flex-col gap-2 rounded-xl bg-muted/50 p-2 transition-shadow",
                dropTarget === stage && "ring-2 ring-ring/40",
              )}
            >
              <header className="flex items-center justify-between px-1 pt-1">
                <h2 className="text-sm font-medium">{STAGE_LABELS[stage]}</h2>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {contacts.length >= COLUMN_LIMIT ? `${COLUMN_LIMIT}+` : contacts.length}
                </span>
              </header>
              {contacts.map((contact) => (
                <ContactCard
                  key={contact.id}
                  contact={contact}
                  now={now}
                  onMove={(target) => move(contact.id, target)}
                />
              ))}
              {contacts.length === 0 && (
                <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                  No contacts
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
