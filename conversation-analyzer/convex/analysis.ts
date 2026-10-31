import { generateText, Output } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { checkEvaluation, evaluationSchema, scoreOf } from "./lib/evaluation";
import type { Step } from "./lib/methodology";
import { getModel } from "./lib/model";
import { buildTranscript } from "./lib/transcript";
import { analysisValidator } from "./schema";

const MAX_ATTEMPTS = 3;

const patchValidator = v.object({
  state: v.optional(analysisValidator.fields.state),
  reason: analysisValidator.fields.reason,
  summary: analysisValidator.fields.summary,
  steps: analysisValidator.fields.steps,
  score: analysisValidator.fields.score,
  model: analysisValidator.fields.model,
  analyzedAt: analysisValidator.fields.analyzedAt,
});

export const load = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation) return null;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversationId))
      .collect();
    return { conversation, messages };
  },
});

export const save = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    requestedAt: v.number(),
    patch: patchValidator,
  },
  handler: async (ctx, { conversationId, requestedAt, patch }) => {
    const conversation = await ctx.db.get(conversationId);
    const analysis = conversation?.analysis;
    if (!conversation || !analysis || analysis.requestedAt !== requestedAt) return null;
    await ctx.db.patch(conversationId, { analysis: { ...analysis, ...patch } });
    return null;
  },
});

function systemPrompt(steps: Step[]): string {
  const list = steps.map((s) => `- ${s.id} — ${s.name}: ${s.description}`).join("\n");
  return [
    "You are a customer support QA reviewer. You read a WhatsApp conversation between a customer and a support agent and evaluate the agent against a methodology.",
    "",
    "Methodology steps:",
    list,
    "",
    "Rules:",
    "- Return exactly one entry per step id above, no more and no fewer.",
    '- verdict is "met" when the agent did it, "not_met" when the agent should have done it but did not, and "not_applicable" when the step did not apply to this conversation.',
    "- evidence is a literal quote copied from the transcript that supports the verdict, or null when there is no quote.",
    "- Write the summary and every reason in the same language as the conversation.",
  ].join("\n");
}

export const analyzeConversation = internalAction({
  args: { conversationId: v.id("conversations"), requestedAt: v.number() },
  handler: async (ctx, { conversationId, requestedAt }) => {
    const data = await ctx.runQuery(internal.analysis.load, { conversationId });
    if (!data) return null;
    const { conversation, messages } = data;
    const analysis = conversation.analysis;
    if (
      conversation.status !== "closed" ||
      analysis?.state !== "pending" ||
      analysis.requestedAt !== requestedAt
    ) {
      return null;
    }

    const save = (patch: typeof patchValidator.type) =>
      ctx.runMutation(internal.analysis.save, { conversationId, requestedAt, patch });

    if (conversation.metrics?.answered === false) {
      await save({ state: "skipped", reason: "no-reply" });
      return null;
    }
    const configured = getModel();
    if (!configured) {
      await save({ state: "skipped", reason: "no-api-key" });
      return null;
    }

    await save({ state: "running" });
    const transcript = buildTranscript(messages);
    const system = systemPrompt(analysis.methodology);
    let lastError = "Analysis failed";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const { output } = await generateText({
          model: configured.model,
          output: Output.object({ schema: evaluationSchema }),
          system,
          prompt: transcript,
          maxRetries: 0,
        });
        const checked = checkEvaluation(output, analysis.methodology, transcript);
        if (!checked.ok) {
          lastError = checked.error;
          continue;
        }
        await save({
          state: "done",
          summary: output.summary,
          steps: checked.steps,
          score: scoreOf(checked.steps),
          model: configured.id,
          analyzedAt: Date.now(),
        });
        return null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await save({ state: "failed", reason: lastError });
    return null;
  },
});
