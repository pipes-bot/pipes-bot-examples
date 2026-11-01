import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/format";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";

const MAX_INSTRUCTIONS = 4000;
const MAX_FAQ = 16000;

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const workspace = useQuery(api.workspaces.current);
  if (workspace === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (workspace === null) return <p className="text-sm text-muted-foreground">No workspace found.</p>;
  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>
      <SettingsForm workspace={workspace} />
      <Separator />
      <DemoSection />
    </div>
  );
}

// Mounted once the workspace has loaded, so the initial state comes from it exactly once.
function SettingsForm({ workspace }: { workspace: Doc<"workspaces"> }) {
  const update = useMutation(api.workspaces.update);
  const modelStatus = useQuery(api.workspaces.modelStatus);
  const [name, setName] = useState(workspace.name);
  const [instructions, setInstructions] = useState(workspace.instructions);
  const [faq, setFaq] = useState(workspace.faq);
  const [idleMinutes, setIdleMinutes] = useState(String(workspace.idleMinutes));
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await update({ name, instructions, faq, idleMinutes: Number(idleMinutes) });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <div className="space-y-1">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="instructions">Instructions</Label>
        <Textarea
          id="instructions"
          rows={6}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {instructions.length}/{MAX_INSTRUCTIONS}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="faq">FAQ</Label>
        <Textarea id="faq" rows={10} value={faq} onChange={(e) => setFaq(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {faq.length}/{MAX_FAQ}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="idle-minutes">Minutes before the AI resumes</Label>
        <Input
          id="idle-minutes"
          type="number"
          min={5}
          max={1440}
          value={idleMinutes}
          onChange={(e) => setIdleMinutes(e.target.value)}
        />
      </div>
      {modelStatus !== undefined && (
        <p className="text-sm text-muted-foreground">
          {modelStatus.kind === "openrouter" ? (
            <>
              OpenRouter: <code>{modelStatus.model}</code>
            </>
          ) : (
            "Demo model — set OPENROUTER_API_KEY to use a real model"
          )}
        </p>
      )}
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

function DemoSection() {
  const seed = useMutation(api.demo.seed);
  const newConversation = useMutation(api.demo.newConversation);
  const reset = useMutation(api.demo.reset);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-medium">Demo</h2>
      <p className="text-sm text-muted-foreground">
        Try the app without a real number: load sample conversations and play customers from the
        conversation page.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => run(() => seed(), "Demo data loaded")}>
          Load demo data
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => newConversation(), "New demo conversation started")}
        >
          New demo conversation
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => reset(), "Demo data removed")}
        >
          Reset demo data
        </Button>
      </div>
    </section>
  );
}
