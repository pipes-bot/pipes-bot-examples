import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { cleanText, isStage, normalizeTags, searchTextOf, type Stage } from "./lib/crm";

// Write helpers shared by the UI mutations, the MCP tools and ingestion. Each validates before
// its first write, so a rejected call leaves no partial state.

type ActivityInput = Pick<
  Doc<"activities">,
  "workspaceId" | "contactId" | "kind" | "actor" | "detail" | "createdAt"
>;

export async function recordActivity(ctx: MutationCtx, a: ActivityInput): Promise<void> {
  await ctx.db.insert("activities", a);
}

type ContactPatch = { stage?: Stage; name?: string; addTags?: string[]; removeTags?: string[] };

/**
 * Applies a stage / name / tag change and records one activity per aspect that actually changed.
 * Throws a ConvexError, before writing anything, if any part of the patch is invalid.
 */
export async function applyContactUpdate(
  ctx: MutationCtx,
  contact: Doc<"contacts">,
  patch: ContactPatch,
  actor: string,
  now: number,
): Promise<Doc<"contacts">> {
  let stage: Stage | undefined;
  if (patch.stage !== undefined) {
    if (!isStage(patch.stage)) throw new ConvexError(`Unknown stage "${String(patch.stage)}"`);
    stage = patch.stage;
  }
  const name = patch.name !== undefined ? cleanText(patch.name, 80, "name") : undefined;
  let tags: string[] | undefined;
  if (patch.addTags?.length || patch.removeTags?.length) {
    const result = normalizeTags(contact.tags, patch.addTags, patch.removeTags);
    if ("error" in result) throw new ConvexError(result.error);
    tags = result.tags;
  }

  const changes: Partial<Doc<"contacts">> = {};
  const activities: Array<[ActivityInput["kind"], string]> = [];

  if (stage !== undefined && stage !== contact.stage) {
    changes.stage = stage;
    activities.push(["stage_changed", `${contact.stage} → ${stage}`]);
  }
  if (name !== undefined && name !== contact.name) {
    changes.name = name;
    changes.searchText = searchTextOf({ ...contact, name });
    activities.push(["renamed", `${contact.name ?? "(no name)"} → ${name}`]);
  }
  if (tags !== undefined) {
    const added = tags.filter((tag) => !contact.tags.includes(tag));
    const removed = contact.tags.filter((tag) => !tags.includes(tag));
    if (added.length > 0 || removed.length > 0) {
      changes.tags = tags;
      activities.push([
        "tags_changed",
        [...added.map((tag) => `+${tag}`), ...removed.map((tag) => `−${tag}`)].join(" "),
      ]);
    }
  }

  if (activities.length === 0) return contact;
  await ctx.db.patch(contact._id, changes);
  for (const [kind, detail] of activities) {
    await recordActivity(ctx, {
      workspaceId: contact.workspaceId,
      contactId: contact._id,
      kind,
      actor,
      detail,
      createdAt: now,
    });
  }
  return { ...contact, ...changes };
}

export async function insertNote(
  ctx: MutationCtx,
  contact: Doc<"contacts">,
  body: string,
  author: string,
  now: number,
): Promise<Id<"notes">> {
  const text = cleanText(body, 2000, "note");
  const noteId = await ctx.db.insert("notes", {
    workspaceId: contact.workspaceId,
    contactId: contact._id,
    body: text,
    author,
    createdAt: now,
  });
  await recordActivity(ctx, {
    workspaceId: contact.workspaceId,
    contactId: contact._id,
    kind: "note_added",
    actor: author,
    detail: text.slice(0, 80),
    createdAt: now,
  });
  return noteId;
}
