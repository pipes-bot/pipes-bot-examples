import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/** Writes the AI reply for `turn`. A stub until the responder lands. */
export const respond = internalAction({
  args: { conversationId: v.id("conversations"), turn: v.number(), attempt: v.number() },
  returns: v.null(),
  handler: async () => null,
});
