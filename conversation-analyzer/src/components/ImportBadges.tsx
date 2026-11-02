import { Badge } from "@/components/ui/badge";
import type { Doc } from "../../convex/_generated/dataModel";

type NumberDoc = Doc<"numbers">;

function historyLabel(history: NonNullable<NumberDoc["historyImport"]>): string {
  switch (history.state) {
    case "importing":
      return history.buildJobId ? "Building history" : `Importing history ${history.progress}%`;
    case "done":
      return "History imported";
    case "declined":
      return "History not shared";
    case "requested":
      return "Waiting for history";
  }
}

export function ImportBadges({ number }: { number: NumberDoc }) {
  const { historyImport, contactsImport } = number;
  const contactsReceived = contactsImport?.state === "received";
  if (!historyImport && !contactsReceived) return <span>—</span>;

  return (
    <div className="flex flex-wrap gap-1">
      {historyImport && (
        <Badge variant={historyImport.state === "declined" ? "destructive" : "secondary"}>
          {historyLabel(historyImport)}
        </Badge>
      )}
      {contactsReceived && <Badge variant="secondary">Contacts imported</Badge>}
    </div>
  );
}
