import { ConvexError, type Infer } from "convex/values";
import type { stepValidator } from "../schema";

export type Step = Infer<typeof stepValidator>;

export const DEFAULT_METHODOLOGY: Step[] = [
  {
    id: "greet",
    name: "Greet the customer",
    description: "The agent opens the conversation with a polite greeting.",
  },
  {
    id: "understand",
    name: "Confirm what the customer needs",
    description: "The agent confirms or asks about what the customer wants before answering.",
  },
  {
    id: "resolve",
    name: "Answer or give a clear next step",
    description: "The agent answers the question or tells the customer exactly what happens next.",
  },
  {
    id: "close",
    name: "Check the customer is satisfied before ending",
    description: "The agent asks whether anything else is needed before closing the conversation.",
  },
];

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return out;
}

export function newStepId(name: string, existing: string[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/g, "") || "step";
  let id = `${slug}-${randomSuffix()}`;
  while (existing.includes(id)) id = `${slug}-${randomSuffix()}`;
  return id;
}

const MIN_INACTIVITY = 5;
const MAX_INACTIVITY = 1440;
const MAX_STEPS = 20;

export function validateSettings(
  input: {
    name: string;
    inactivityMinutes: number;
    methodology: { id?: string; name: string; description: string }[];
  },
  existingIds: string[],
): { name: string; inactivityMinutes: number; methodology: Step[] } {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new ConvexError("name must be between 1 and 80 characters");
  }
  const { inactivityMinutes } = input;
  if (
    !Number.isInteger(inactivityMinutes) ||
    inactivityMinutes < MIN_INACTIVITY ||
    inactivityMinutes > MAX_INACTIVITY
  ) {
    throw new ConvexError(
      `inactivityMinutes must be an integer between ${MIN_INACTIVITY} and ${MAX_INACTIVITY}`,
    );
  }
  if (input.methodology.length < 1 || input.methodology.length > MAX_STEPS) {
    throw new ConvexError(`methodology must have between 1 and ${MAX_STEPS} steps`);
  }

  const used = [...existingIds];
  const given = input.methodology.map((step) => step.id?.trim() || undefined);
  for (const id of given) if (id) used.push(id);

  const methodology = input.methodology.map((step, index): Step => {
    const stepName = step.name.trim();
    if (stepName.length < 1 || stepName.length > 80) {
      throw new ConvexError(`methodology step ${index + 1} name must be between 1 and 80 characters`);
    }
    const description = step.description.trim();
    if (description.length > 500) {
      throw new ConvexError(
        `methodology step ${index + 1} description must be at most 500 characters`,
      );
    }
    let id = given[index];
    if (!id) {
      id = newStepId(stepName, used);
      used.push(id);
    }
    return { id, name: stepName, description };
  });

  const seen = new Set<string>();
  for (const step of methodology) {
    if (seen.has(step.id)) throw new ConvexError(`methodology has a duplicate step id: ${step.id}`);
    seen.add(step.id);
  }
  return { name, inactivityMinutes, methodology };
}
