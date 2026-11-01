import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const MCP_URL = `${import.meta.env.VITE_CONVEX_SITE_URL}/mcp`;

function isLocal(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }

  return (
    <Button type="button" variant="outline" size="icon-sm" onClick={() => void copy()} aria-label={label} title={label}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

function CodeLine({ text, copyLabel }: { text: string; copyLabel: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-xs" title={text}>
        {text}
      </code>
      <CopyButton text={text} label={copyLabel} />
    </div>
  );
}

/** The MCP endpoint and how to add it to the common clients. */
export function McpConnect() {
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <p className="font-medium">Server URL</p>
        <CodeLine text={MCP_URL} copyLabel="Copy the MCP URL" />
      </div>
      <div className="space-y-1.5">
        <p className="font-medium">Claude Code</p>
        <CodeLine
          text={`claude mcp add --transport http mini-crm ${MCP_URL}`}
          copyLabel="Copy the Claude Code command"
        />
      </div>
      <div className="space-y-1">
        <p className="font-medium">claude.ai</p>
        <p className="text-muted-foreground">Settings → Connectors → Add custom connector, then paste the URL.</p>
      </div>
      <div className="space-y-1">
        <p className="font-medium">ChatGPT</p>
        <p className="text-muted-foreground">Turn on developer mode, add a connector, then paste the URL.</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Each client opens a sign-in page here and asks for your consent before it can use the workspace.
        {isLocal(MCP_URL) &&
          " claude.ai and ChatGPT connect from their own servers, so they need a deployed URL; this local one works with Claude Code."}
      </p>
    </div>
  );
}
