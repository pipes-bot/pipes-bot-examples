import { Link, createFileRoute } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { HealthBadge } from "@/components/HealthBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  async function connect() {
    setConnecting(true);
    setError(undefined);
    try {
      const { url } = await createSignupLink();
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
        <Button onClick={connect} disabled={connecting}>
          {connecting ? "Opening…" : "Connect a number"}
        </Button>
      </div>
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
