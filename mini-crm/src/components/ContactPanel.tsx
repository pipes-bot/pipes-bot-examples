import { useMutation } from "convex/react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { TagEditor } from "@/components/TagEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { STAGE_LABELS, errorMessage, formatDateTime, formatAgo, useNow } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import type { ContactSummary } from "../../convex/crmRead";
import { STAGES, type Stage } from "../../convex/lib/crm";

const ACTIVITY_LABELS: Record<Doc<"activities">["kind"], string> = {
  contact_created: "created the contact",
  stage_changed: "changed the stage",
  tags_changed: "changed tags",
  renamed: "renamed the contact",
  note_added: "added a note",
  message_sent: "sent a message",
  draft_created: "drafted a reply",
  draft_decided: "decided on a draft",
};

/** "you" and "system" are fixed actor strings; anything else is an MCP client's name. */
function actorLabel(actor: string): string {
  if (actor === "you") return "You";
  if (actor === "system") return "System";
  return actor;
}

export function ContactPanel({
  contact,
  notes,
  activities,
}: {
  contact: ContactSummary;
  notes: Doc<"notes">[];
  activities: Doc<"activities">[];
}) {
  const update = useMutation(api.contacts.update);
  const addNote = useMutation(api.contacts.addNote);
  const now = useNow(30_000);
  const contactId = contact.id;

  async function change(patch: { stage?: Stage; name?: string; addTags?: string[]; removeTags?: string[] }) {
    try {
      await update({ contactId, ...patch });
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  }

  return (
    <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l p-4 text-sm" aria-label="Contact details">
      <div className="space-y-2">
        <Label htmlFor="contact-stage">Stage</Label>
        <Select value={contact.stage} onValueChange={(stage) => void change({ stage: stage as Stage }).catch(() => {})}>
          <SelectTrigger id="contact-stage" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STAGES.map((stage) => (
              <SelectItem key={stage} value={stage}>
                {STAGE_LABELS[stage]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Keyed so the field resets when the name changes elsewhere (another tab, an MCP client). */}
      <NameField key={contact.name ?? ""} name={contact.name} onSave={(name) => change({ name })} />

      <div className="space-y-2">
        <Label>Tags</Label>
        <TagEditor
          tags={contact.tags}
          onAdd={(tag) => change({ addTags: [tag] })}
          onRemove={(tag) => change({ removeTags: [tag] })}
        />
      </div>

      <Separator />

      <div className="space-y-2">
        <h2 className="text-sm font-medium">Notes</h2>
        <NoteForm onAdd={(body) => addNote({ contactId, body })} />
        {notes.length > 0 && (
          <ul className="space-y-2">
            {notes.map((note) => (
              <li key={note._id} className="rounded-lg bg-muted/50 p-2">
                <p className="whitespace-pre-wrap break-words">{note.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {actorLabel(note.author)} · {formatAgo(note.createdAt, now)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Separator />

      <div className="space-y-2">
        <h2 className="text-sm font-medium">Activity</h2>
        {activities.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity yet.</p>
        ) : (
          <ol className="space-y-2 border-l pl-3">
            {activities.map((activity) => (
              <li key={activity._id} className="text-xs">
                <p>
                  <span className="font-medium">{actorLabel(activity.actor)}</span>{" "}
                  {ACTIVITY_LABELS[activity.kind]}
                </p>
                {activity.detail && <p className="break-words text-muted-foreground">{activity.detail}</p>}
                <p className="text-muted-foreground" title={formatDateTime(activity.createdAt)}>
                  {formatAgo(activity.createdAt, now)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

function NameField({ name, onSave }: { name?: string; onSave: (name: string) => Promise<void> }) {
  const [value, setValue] = useState(name ?? "");
  const [saving, setSaving] = useState(false);
  const changed = value.trim() !== (name ?? "") && value.trim().length > 0;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!changed) return;
    setSaving(true);
    try {
      await onSave(value.trim());
    } catch {
      // Reported by the caller.
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Label htmlFor="contact-name">Name</Label>
      <div className="flex gap-2">
        <Input
          id="contact-name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={80}
          placeholder="Add a name"
        />
        {changed && (
          <Button type="submit" size="sm" variant="outline" disabled={saving} className="h-8">
            Save
          </Button>
        )}
      </div>
    </form>
  );
}

function NoteForm({ onAdd }: { onAdd: (body: string) => Promise<unknown> }) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (body.trim().length === 0) return;
    setSaving(true);
    try {
      await onAdd(body);
      setBody("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={2000}
        placeholder="Add a note"
        aria-label="Note"
        className="min-h-14"
      />
      <Button type="submit" size="sm" variant="outline" disabled={saving || body.trim().length === 0}>
        {saving ? "Adding…" : "Add note"}
      </Button>
    </form>
  );
}
