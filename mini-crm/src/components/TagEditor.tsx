import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

/** Tags as removable chips plus an input; Enter adds. The server normalizes (trim, lowercase). */
export function TagEditor({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (tag: string) => Promise<void>;
  onRemove: (tag: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const tag = value.trim();
    if (!tag || busy) return;
    setBusy(true);
    try {
      await onAdd(tag);
      setValue("");
    } catch {
      // The caller already reported it; keep the text so it can be fixed.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <li key={tag}>
              <Badge variant="secondary" className="pr-1">
                {tag}
                <button
                  type="button"
                  onClick={() => void onRemove(tag).catch(() => {})}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label={`Remove tag ${tag}`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No tags.</p>
      )}
      <form onSubmit={onSubmit}>
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Add a tag and press Enter"
          aria-label="Add tag"
          maxLength={64}
          className="h-7 text-xs"
        />
      </form>
    </div>
  );
}
