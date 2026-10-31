import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { MethodologyEditor, type EditableStep } from "@/components/MethodologyEditor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/format";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const workspace = useQuery(api.workspaces.current);
  if (workspace === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (workspace === null) return <p className="text-sm text-muted-foreground">No workspace found.</p>;
  return <SettingsForm workspace={workspace} />;
}

// Mounted only once the workspace has loaded, so the initial state comes from it exactly once.
function SettingsForm({ workspace }: { workspace: Doc<"workspaces"> }) {
  const updateSettings = useMutation(api.workspaces.updateSettings);
  const [name, setName] = useState(workspace.name);
  const [inactivityMinutes, setInactivityMinutes] = useState(String(workspace.inactivityMinutes));
  const [steps, setSteps] = useState<EditableStep[]>(() =>
    workspace.methodology.map((step) => ({ ...step, key: step.id })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await updateSettings({
        name,
        inactivityMinutes: Number(inactivityMinutes),
        methodology: steps.map(({ id, name, description }) => ({ id, name, description })),
      });
      toast.success("Settings saved");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="space-y-1">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="inactivity-minutes">Close conversations after (minutes of inactivity)</Label>
        <Input
          id="inactivity-minutes"
          type="number"
          min={5}
          max={1440}
          value={inactivityMinutes}
          onChange={(e) => setInactivityMinutes(e.target.value)}
        />
      </div>
      <section className="space-y-3">
        <h2 className="text-base font-medium">Methodology</h2>
        <MethodologyEditor steps={steps} onChange={setSteps} />
      </section>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
