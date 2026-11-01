import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { McpConnect } from "@/components/McpConnect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errorMessage, formatDateTime } from "@/lib/format";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";

export const Route = createFileRoute("/_app/settings")({
  component: Settings,
});

type SendMode = Doc<"workspaces">["mcpSendMode"];

const SEND_MODES: { value: SendMode; title: string; description: string }[] = [
  {
    value: "draft",
    title: "Drafts (recommended)",
    description: "Claude prepares replies, you approve them in the inbox.",
  },
  {
    value: "direct",
    title: "Send directly",
    description:
      "Claude's messages go out immediately. Anyone who can message your number could try to steer Claude through their messages.",
  },
];

// Matches the consent page; openid/profile/email are implied by signing in.
const SCOPE_LABELS: Record<string, string> = {
  "crm:read": "Read",
  "crm:write": "Write",
  offline_access: "Offline access",
};

function Settings() {
  const workspace = useQuery(api.workspaces.current);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      {workspace === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : workspace === null ? (
        <p className="text-sm text-muted-foreground">Workspace not found.</p>
      ) : (
        <>
          <WorkspaceCard key={workspace.name} name={workspace.name} />
          <SendModeCard mode={workspace.mcpSendMode} />
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Connect an MCP client</CardTitle>
          <CardDescription>
            Let Claude or another MCP client search contacts, update the pipeline and draft replies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <McpConnect />
        </CardContent>
      </Card>
      <ConnectedAppsCard />
      <DemoCard />
    </div>
  );
}

function WorkspaceCard({ name }: { name: string }) {
  const update = useMutation(api.workspaces.update);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const changed = value.trim() !== name;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await update({ name: value });
      toast.success("Workspace name saved");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-2">
          <Label htmlFor="workspace-name">Name</Label>
          <div className="flex gap-2">
            <Input
              id="workspace-name"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={80}
              required
            />
            <Button type="submit" variant="outline" disabled={!changed || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SendModeCard({ mode }: { mode: SendMode }) {
  const update = useMutation(api.workspaces.update);

  async function choose(next: SendMode) {
    try {
      await update({ mcpSendMode: next });
      toast.success(next === "draft" ? "MCP messages now wait for your approval" : "MCP messages now go out directly");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>How MCP clients send messages</CardTitle>
        <CardDescription>Applies to every connected app.</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset className="space-y-2">
          <legend className="sr-only">MCP send mode</legend>
          {SEND_MODES.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40",
                mode === option.value && "border-foreground/30 bg-muted/40",
              )}
            >
              <input
                type="radio"
                name="mcpSendMode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => void choose(option.value)}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{option.title}</span>
                <span className="block text-sm text-muted-foreground">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </CardContent>
    </Card>
  );
}

function ConnectedAppsCard() {
  const apps = useQuery(api.connectedApps.list);
  const revoke = useMutation(api.connectedApps.revoke);
  const [revoking, setRevoking] = useState<string>();

  async function onRevoke(clientId: string, clientName: string) {
    setRevoking(clientId);
    try {
      await revoke({ clientId });
      toast.success(`${clientName} can no longer use this workspace`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRevoking(undefined);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected apps</CardTitle>
        <CardDescription>
          Apps you allowed to use this workspace. Revoking takes effect on the app's next request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {apps === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : apps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No apps connected yet.</p>
        ) : (
          <ul className="divide-y">
            {apps.map((app) => {
              const scopes = app.scopes.filter((scope) => Object.hasOwn(SCOPE_LABELS, scope));
              return (
                <li key={app.clientId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1 space-y-1">
                    {/* The name comes from the client's own registration, so it is not verified. */}
                    <p className="truncate text-sm font-medium" title={app.clientId}>
                      {app.clientName}
                    </p>
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {scopes.map((scope) => (
                        <Badge key={scope} variant="secondary">
                          {SCOPE_LABELS[scope]}
                        </Badge>
                      ))}
                      {app.createdAt !== undefined && <span>Connected {formatDateTime(app.createdAt)}</span>}
                    </div>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={revoking === app.clientId}
                    onClick={() => void onRevoke(app.clientId, app.clientName)}
                  >
                    {revoking === app.clientId ? "Revoking…" : "Revoke"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DemoCard() {
  const seed = useMutation(api.demo.seed);
  const reset = useMutation(api.demo.reset);
  const [pending, setPending] = useState<"seed" | "reset">();

  async function run(kind: "seed" | "reset") {
    setPending(kind);
    try {
      if (kind === "seed") {
        const { contacts } = await seed();
        toast.success(`Demo data loaded: ${contacts} contacts on a demo number`);
      } else {
        await reset();
        toast.success("Demo data removed");
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Demo data</CardTitle>
        <CardDescription>
          Sample contacts, conversations and a draft from Claude on a demo number. Messages sent to demo
          contacts never leave this app. Reset removes only the demo data.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button disabled={pending !== undefined} onClick={() => void run("seed")}>
          {pending === "seed" ? "Loading…" : "Load demo data"}
        </Button>
        <Button variant="outline" disabled={pending !== undefined} onClick={() => void run("reset")}>
          {pending === "reset" ? "Resetting…" : "Reset demo data"}
        </Button>
      </CardContent>
    </Card>
  );
}
