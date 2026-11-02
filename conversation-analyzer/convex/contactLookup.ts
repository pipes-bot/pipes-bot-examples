import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

type Ids = { waId?: string; userId?: string };

export async function contactByUserId(ctx: MutationCtx, numberId: Id<"numbers">, userId: string) {
  return ctx.db
    .query("contacts")
    .withIndex("by_number_user_id", (q) => q.eq("numberId", numberId).eq("userId", userId))
    .first();
}

export async function contactByWaId(ctx: MutationCtx, numberId: Id<"numbers">, waId: string) {
  return ctx.db
    .query("contacts")
    .withIndex("by_number_wa_id", (q) => q.eq("numberId", numberId).eq("waId", waId))
    .first();
}

/** Finds the contact by BSUID, then by phone; creates it or fills what was missing. */
export async function resolveContact(
  ctx: MutationCtx,
  numberId: Id<"numbers">,
  ids: Ids,
  name: string | undefined,
): Promise<Id<"contacts"> | null> {
  if (!ids.waId && !ids.userId) return null;
  const contact =
    (ids.userId ? await contactByUserId(ctx, numberId, ids.userId) : null) ??
    (ids.waId ? await contactByWaId(ctx, numberId, ids.waId) : null);
  if (!contact) return ctx.db.insert("contacts", { numberId, ...ids, ...(name ? { name } : {}) });

  const patch: Partial<Doc<"contacts">> = {};
  if (!contact.waId && ids.waId) patch.waId = ids.waId;
  if (!contact.userId && ids.userId) patch.userId = ids.userId;
  if (!contact.name && name) patch.name = name;
  if (Object.keys(patch).length > 0) await ctx.db.patch(contact._id, patch);
  return contact._id;
}
