import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/format";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Props = { conversationId: Id<"conversations"> };

function SimulatorField({
  label,
  button,
  onSend,
}: {
  label: string;
  button: string;
  onSend: (text: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await onSend(text);
      setText("");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <Input
        aria-label={label}
        placeholder={label}
        value={text}
        maxLength={4096}
        onChange={(e) => setText(e.target.value)}
      />
      <Button type="submit" disabled={sending || !text.trim()}>
        {button}
      </Button>
    </form>
  );
}

export function Simulator({ conversationId }: Props) {
  const simulateInbound = useMutation(api.demo.simulateInbound);
  const simulateEcho = useMutation(api.demo.simulateEcho);
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-base font-medium">Simulator</h2>
      <SimulatorField
        label="Customer message"
        button="Send as customer"
        onSend={(text) => simulateInbound({ conversationId, text })}
      />
      <SimulatorField
        label="Staff reply"
        button="Reply as staff from phone"
        onSend={(text) => simulateEcho({ conversationId, text })}
      />
      <p className="text-xs text-muted-foreground">
        The AI answers about 4 seconds after a customer message.
      </p>
    </section>
  );
}
