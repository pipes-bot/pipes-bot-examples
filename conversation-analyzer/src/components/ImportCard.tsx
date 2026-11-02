import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/** `history.importStatus` stops counting at this value. */
const COUNT_CAP = 1000;

/** Conversations one `history.analyzeImported` call queues (`ANALYZE_BATCH`). */
const ANALYZE_BATCH = 100;

function count(n: number): string {
  return n >= COUNT_CAP ? `${COUNT_CAP}+` : String(n);
}

const STATE_LABELS = {
  requested: "Waiting for history",
  importing: "Importing history",
  done: "History imported",
  declined: "History not shared",
} as const;

export function ImportCard({ numberId }: { numberId: Id<"numbers"> }) {
  const status = useQuery(api.history.importStatus, { numberId });
  const analyzeImported = useMutation(api.history.analyzeImported);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!status) return null;
  const { historyImport, contactsImport } = status;

  async function analyze() {
    setBusy(true);
    try {
      const { requested, remaining } = await analyzeImported({ numberId });
      toast.success(
        remaining > 0
          ? `Analyzing ${requested} conversations, ${remaining} left to analyze.`
          : `Analyzing ${requested} conversations.`,
      );
      setConfirming(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {historyImport && (
            <>
              <dt className="text-muted-foreground">History</dt>
              <dd>
                {status.building && historyImport.state === "importing"
                  ? "Building history"
                  : STATE_LABELS[historyImport.state]}
                {historyImport.state === "importing" && (
                  <span className="tabular-nums"> · {historyImport.progress}%</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Imported conversations</dt>
              <dd className="tabular-nums">{status.importedConversations}</dd>
            </>
          )}
          {contactsImport && (
            <>
              <dt className="text-muted-foreground">Contacts</dt>
              <dd>
                {contactsImport.state === "received" ? "Contacts imported" : "Waiting for contacts"}
              </dd>
              <dt className="text-muted-foreground">Contacts with a book name</dt>
              <dd className="tabular-nums">{count(status.bookContacts)}</dd>
            </>
          )}
        </dl>
        {historyImport?.state === "declined" && (
          <p className="text-muted-foreground">
            The business chose not to share chat history on the phone. WhatsApp only allows the
            import once, so it can't be requested again for this number.
          </p>
        )}
        {status.unanalyzed > 0 && (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Analyze imported conversations ({count(status.unanalyzed)})
          </Button>
        )}
      </CardContent>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Analyze imported conversations</DialogTitle>
            <DialogDescription>
              This runs the AI analysis on {Math.min(status.unanalyzed, ANALYZE_BATCH)}{" "}
              conversations using your OpenRouter key.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={analyze}>
              {busy ? "Starting…" : "Analyze"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
