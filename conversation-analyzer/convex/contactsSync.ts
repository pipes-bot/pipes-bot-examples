import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { contactByWaId } from "./contactLookup";
import { list, waTimestampMs } from "./lib/payload";

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Applies one `smb_app_state_sync` envelope: the business phone's address book.
 * An `add` names the contact; a `remove` clears the name but keeps the row,
 * because conversations point at it. Items older than what is already applied
 * are ignored, since edits can arrive out of order.
 */
export async function applyStateSync(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  whatsapp: any,
  now: number,
): Promise<void> {
  let applied = false;
  for (const item of list(whatsapp?.state_sync)) {
    if (item?.type !== "contact") continue;
    const waId = nonEmpty(item.contact?.phone_number);
    if (!waId) continue;
    const at = waTimestampMs(item.metadata?.timestamp, now);
    const contact = await contactByWaId(ctx, number._id, waId);
    if (contact?.bookUpdatedAt !== undefined && contact.bookUpdatedAt > at) continue;

    if (item.action === "add") {
      const bookName = nonEmpty(item.contact.full_name) ?? nonEmpty(item.contact.first_name);
      if (contact) {
        await ctx.db.patch(contact._id, {
          ...(bookName ? { bookName } : {}),
          bookUpdatedAt: at,
          bookRemovedAt: undefined,
        });
      } else {
        await ctx.db.insert("contacts", {
          numberId: number._id,
          waId,
          ...(bookName ? { bookName } : {}),
          bookUpdatedAt: at,
        });
      }
      applied = true;
    } else if (item.action === "remove") {
      if (!contact) continue;
      await ctx.db.patch(contact._id, { bookName: undefined, bookUpdatedAt: at, bookRemovedAt: at });
      applied = true;
    }
  }

  // The first applied event means the initial list arrived; later edits only refresh the time.
  if (applied) await ctx.db.patch(number._id, { contactsImport: { state: "received", updatedAt: now } });
}
