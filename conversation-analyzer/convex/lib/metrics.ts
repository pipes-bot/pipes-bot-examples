import type { Infer } from "convex/values";
import type { metricsValidator, sourceValidator } from "../schema";

export type Source = Infer<typeof sourceValidator>;
export type Metrics = Infer<typeof metricsValidator>;

/**
 * A turn starts at a customer message that follows a business message
 * (phone/api) or starts the list. It is answered by the first business
 * message after it.
 */
export function computeMetrics(messages: { source: Source; sentAt: number }[]): Metrics {
  const sorted = [...messages].sort((a, b) => a.sentAt - b.sentAt);
  const counts = { customer: 0, phone: 0, api: 0 };
  const responseMs: number[] = [];
  let firstTurnIsFirstMessage = false;
  let turnStart: number | undefined;
  let unansweredTurns = 0;
  let previousWasCustomer = false;

  sorted.forEach((message, index) => {
    counts[message.source] += 1;
    if (message.source === "customer") {
      if (!previousWasCustomer) {
        turnStart = message.sentAt;
        if (index === 0) firstTurnIsFirstMessage = true;
      }
      previousWasCustomer = true;
      return;
    }
    if (turnStart !== undefined) {
      responseMs.push(message.sentAt - turnStart);
      turnStart = undefined;
    }
    previousWasCustomer = false;
  });
  if (turnStart !== undefined) unansweredTurns = 1;

  const seconds = responseMs.map((ms) => Math.round(ms / 1000));
  const result: Metrics = {
    unansweredTurns,
    answered: seconds.length > 0,
    durationSeconds:
      sorted.length > 0 ? Math.round((sorted[sorted.length - 1].sentAt - sorted[0].sentAt) / 1000) : 0,
    counts,
  };
  if (seconds.length > 0) {
    if (firstTurnIsFirstMessage) result.firstResponseSeconds = seconds[0];
    result.avgResponseSeconds = Math.round(seconds.reduce((sum, s) => sum + s, 0) / seconds.length);
    result.maxResponseSeconds = Math.max(...seconds);
  }
  return result;
}
