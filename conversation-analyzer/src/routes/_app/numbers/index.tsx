import { Link, createFileRoute } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { HealthBadge } from "@/components/HealthBadge";
import { ImportBadges } from "@/components/ImportBadges";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage, formatDateTime } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";

export const Route = createFileRoute("/_app/numbers/")({
  component: Numbers,
});

function Numbers() {
  const numbers = useQuery(api.numbers.list);
  const createSignupLink = useAction(api.numbers.createSignupLink);
  const [panelOpen, setPanelOpen] = useState(false);
  const [importHistory, setImportHistory] = useState(true);
  const [importContacts, setImportContacts] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  async function connect() {
    setConnecting(true);
    setError(undefined);
    try {
      const { url } = await createSignupLink({ importHistory, importContacts });
      window.location.href = url;
    } catch (e) {
      setError(errorMessage(e));
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Numbers</h1>
        <Button onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}>
          Connect a number
        </Button>
      </div>
      {panelOpen && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <input
              id="import-history"
              type="checkbox"
              checked={importHistory}
              onChange={(e) => setImportHistory(e.target.checked)}
            />
            <Label htmlFor="import-history">Import chat history (up to 6 months)</Label>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="import-contacts"
              type="checkbox"
              checked={importContacts}
              onChange={(e) => setImportContacts(e.target.checked)}
            />
            <Label htmlFor="import-contacts">Import contacts</Label>
          </div>
          <p className="text-sm text-muted-foreground">
            Only for numbers on the WhatsApp Business app. Your phone will ask whether to share
            chat history. WhatsApp allows the import once, right after connecting.
          </p>
          <Button onClick={connect} disabled={connecting}>
            {connecting ? "Opening…" : "Continue"}
          </Button>
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {numbers === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : numbers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No numbers connected yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Connected</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Import</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {numbers.map((number) => (
              <TableRow key={number._id}>
                <TableCell>
                  <Link
                    to="/numbers/$numberId"
                    params={{ numberId: number._id }}
                    className="font-medium hover:underline"
                  >
                    {number.displayName || number.phoneNumber || number.poolNumberId}
                  </Link>
                </TableCell>
                <TableCell>{number.phoneNumber}</TableCell>
                <TableCell>{formatDateTime(number.connectedAt)}</TableCell>
                <TableCell>
                  <HealthBadge health={number.health} />
                </TableCell>
                <TableCell>
                  <ImportBadges number={number} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
