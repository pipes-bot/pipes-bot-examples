import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { requireNumber, requireWorkspace } from "./authz";
import { healthValidator } from "./schema";

const DEFAULT_API_BASE_URL = "https://api.pipes.bot";
const HEALTH_TIMEOUT_MS = 15_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConvexError(`${name} is not set`);
  return value;
}

function apiBaseUrl(): string {
  return process.env.PIPES_API_BASE_URL || DEFAULT_API_BASE_URL;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const workspace = await requireWorkspace(ctx);
    const numbers = await ctx.db
      .query("numbers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    return numbers.sort((a, b) => b.connectedAt - a.connectedAt);
  },
});

export const get = query({
  args: { numberId: v.id("numbers") },
  handler: async (ctx, { numberId }) => (await requireNumber(ctx, numberId)).number,
});

export const findByPoolNumberId = query({
  args: { poolNumberId: v.string() },
  handler: async (ctx, { poolNumberId }) => {
    const workspace = await requireWorkspace(ctx);
    const number = await ctx.db
      .query("numbers")
      .withIndex("by_pool_number", (q) => q.eq("poolNumberId", poolNumberId))
      .first();
    return number && number.workspaceId === workspace._id ? number : null;
  },
});

export const createSignupLink = action({
  args: { importHistory: v.boolean(), importContacts: v.boolean() },
  handler: async (ctx, { importHistory, importContacts }): Promise<{ url: string }> => {
    const ownerId = (await ctx.auth.getUserIdentity())?.subject;
    if (!ownerId) throw new ConvexError("Not signed in");
    const workspace = await ctx.runQuery(internal.workspaces.byOwner, { ownerId });
    if (!workspace) throw new ConvexError("Workspace not found");

    const apiKey = requireEnv("PIPES_API_KEY");
    const appSlug = requireEnv("PIPES_APP_SLUG");
    const siteUrl = requireEnv("SITE_URL");

    const response = await fetch(`${apiBaseUrl()}/v1/apps/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        redirectUrl: `${siteUrl}/numbers/connected`,
        metadata: { workspaceId: workspace._id },
        importHistory,
        importContacts,
      }),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      throw new ConvexError(`Could not create a signup link (${response.status}): ${text}`);
    }
    const { token } = (await response.json()) as { token?: string };
    if (!token) throw new ConvexError("Could not create a signup link: no token in response");
    return { url: `https://app.pipes.bot/apps/${appSlug}?token=${encodeURIComponent(token)}` };
  },
});

export const allNumbers = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("numbers").collect(),
});

export const setHealth = internalMutation({
  args: { numberId: v.id("numbers"), health: healthValidator },
  handler: async (ctx, { numberId, health }) => {
    await ctx.db.patch(numberId, { health });
    return null;
  },
});

type Health = { state: "healthy" | "unhealthy" | "unknown"; checkedAt: number; detail?: string };

type HealthResponse = {
  canSendMessage?: string;
  entities?: { errors?: { description?: string }[] }[];
};

async function fetchHealth(poolNumberId: string, apiKey: string): Promise<Health> {
  const checkedAt = Date.now();
  try {
    const response = await fetch(
      `${apiBaseUrl()}/v1/pool-numbers/${encodeURIComponent(poolNumberId)}/health`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      },
    );
    if (!response.ok) return { state: "unknown", checkedAt, detail: `HTTP ${response.status}` };
    const body = (await response.json()) as HealthResponse;
    if (body.canSendMessage === "AVAILABLE") return { state: "healthy", checkedAt };
    if (body.canSendMessage === "LIMITED" || body.canSendMessage === "BLOCKED") {
      const description = body.entities
        ?.flatMap((entity) => entity.errors ?? [])
        .find((error) => error.description)?.description;
      return { state: "unhealthy", checkedAt, detail: description ?? body.canSendMessage };
    }
    return { state: "unknown", checkedAt, detail: body.canSendMessage ?? "No status reported" };
  } catch (error) {
    return {
      state: "unknown",
      checkedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export const checkHealth = internalAction({
  args: {},
  handler: async (ctx) => {
    const numbers = (await ctx.runQuery(internal.numbers.allNumbers, {})).filter((n) => !n.isDemo);
    if (numbers.length === 0) return null;
    // The hourly cron must not throw when the demo runs without pipes.bot credentials.
    const apiKey = process.env.PIPES_API_KEY;
    for (const number of numbers) {
      const health: Health = apiKey
        ? await fetchHealth(number.poolNumberId, apiKey)
        : { state: "unknown", checkedAt: Date.now(), detail: "PIPES_API_KEY is not set" };
      await ctx.runMutation(internal.numbers.setHealth, { numberId: number._id, health });
    }
    return null;
  },
});
