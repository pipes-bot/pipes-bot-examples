import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { DEFAULT_METHODOLOGY, newStepId, validateSettings } from "./methodology";

const valid = {
  name: "Acme",
  inactivityMinutes: 120,
  methodology: [{ name: "Greet", description: "Say hi" }],
};

describe("DEFAULT_METHODOLOGY", () => {
  it("has the four default steps with descriptions", () => {
    expect(DEFAULT_METHODOLOGY.map((s) => [s.id, s.name])).toEqual([
      ["greet", "Greet the customer"],
      ["understand", "Confirm what the customer needs"],
      ["resolve", "Answer or give a clear next step"],
      ["close", "Check the customer is satisfied before ending"],
    ]);
    for (const step of DEFAULT_METHODOLOGY) expect(step.description.length).toBeGreaterThan(0);
  });
});

describe("newStepId", () => {
  it("slugifies the name and appends 4 random chars", () => {
    expect(newStepId("Greet the customer!", [])).toMatch(/^greet-the-customer-[a-z0-9]{4}$/);
  });

  it("falls back to 'step' for empty slugs", () => {
    expect(newStepId("!!!", [])).toMatch(/^step-[a-z0-9]{4}$/);
  });

  it("caps the slug at 24 characters", () => {
    expect(newStepId("a".repeat(60), [])).toMatch(/^a{24}-[a-z0-9]{4}$/);
  });

  it("regenerates on collision", () => {
    const existing: string[] = [];
    for (let i = 0; i < 50; i++) existing.push(newStepId("x", existing));
    expect(new Set(existing).size).toBe(50);
  });
});

describe("validateSettings", () => {
  it("assigns ids to new steps, keeps given ids and trims strings", () => {
    const result = validateSettings(
      {
        name: "  Acme  ",
        inactivityMinutes: 30,
        methodology: [
          { id: "greet", name: " Greet ", description: " Say hi " },
          { name: "Close it", description: "" },
        ],
      },
      ["greet"],
    );
    expect(result.name).toBe("Acme");
    expect(result.inactivityMinutes).toBe(30);
    expect(result.methodology[0]).toEqual({ id: "greet", name: "Greet", description: "Say hi" });
    expect(result.methodology[1].id).toMatch(/^close-it-[a-z0-9]{4}$/);
    expect(result.methodology[1].description).toBe("");
  });

  const thrownData = (input: Parameters<typeof validateSettings>[0]): unknown => {
    try {
      validateSettings(input, []);
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
      return (error as ConvexError<string>).data;
    }
    throw new Error("validateSettings did not throw");
  };

  it("rejects invalid input with a message naming the field", () => {
    const cases: [Parameters<typeof validateSettings>[0], string][] = [
      [{ ...valid, methodology: [] }, "methodology must have between 1 and 20 steps"],
      [
        { ...valid, methodology: Array.from({ length: 21 }, (_, i) => ({ name: `S${i}`, description: "" })) },
        "methodology must have between 1 and 20 steps",
      ],
      [{ ...valid, inactivityMinutes: 0 }, "inactivityMinutes must be an integer between 5 and 1440"],
      [{ ...valid, inactivityMinutes: 4 }, "inactivityMinutes must be an integer between 5 and 1440"],
      [{ ...valid, inactivityMinutes: 5000 }, "inactivityMinutes must be an integer between 5 and 1440"],
      [{ ...valid, inactivityMinutes: 12.5 }, "inactivityMinutes must be an integer between 5 and 1440"],
      [{ ...valid, name: "  " }, "name must be between 1 and 80 characters"],
      [{ ...valid, name: "x".repeat(81) }, "name must be between 1 and 80 characters"],
      [
        { ...valid, methodology: [{ name: "  ", description: "" }] },
        "methodology step 1 name must be between 1 and 80 characters",
      ],
      [
        { ...valid, methodology: [{ name: "A", description: "x".repeat(501) }] },
        "methodology step 1 description must be at most 500 characters",
      ],
      [
        {
          ...valid,
          methodology: [
            { id: "a", name: "A", description: "" },
            { id: "a", name: "B", description: "" },
          ],
        },
        "methodology has a duplicate step id: a",
      ],
    ];
    for (const [input, message] of cases) {
      expect(thrownData(input)).toBe(message);
    }
  });
});
