import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

// Returns null when OPENROUTER_API_KEY is not set, so analysis can be skipped.
export function getModel(): { model: LanguageModel; id: string } | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const id = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const model = createOpenRouter({ apiKey }).chat(id, {
    provider: { zdr: true, data_collection: "deny" },
  });
  return { model, id };
}
