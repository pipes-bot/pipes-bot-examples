import { createAuth } from "../auth";

// Static instance used only by the Better Auth schema generator (`npx auth generate`).
// Keep this file free of anything else: it is evaluated without Convex env vars.
export const auth = createAuth({} as any);
