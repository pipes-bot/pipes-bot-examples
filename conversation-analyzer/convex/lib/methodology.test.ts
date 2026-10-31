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

  it("rejects invalid input", () => {
    const cases = [
      { ...valid, methodology: [] },
      { ...valid, inactivityMinutes: 0 },
      { ...valid, inactivityMinutes: 5000 },
      { ...valid, inactivityMinutes: 12.5 },
      { ...valid, name: "  " },
      { ...valid, methodology: [{ name: "  ", description: "" }] },
      { ...valid, methodology: [{ name: "A", description: "x".repeat(501) }] },
      {
        ...valid,
        methodology: [
          { id: "a", name: "A", description: "" },
          { id: "a", name: "B", description: "" },
        ],
      },
    ];
    for (const input of cases) {
      expect(() => validateSettings(input, [])).toThrow(ConvexError);
    }
  });

  it("rejects more than 20 steps and names the field", () => {
    const methodology = Array.from({ length: 21 }, (_, i) => ({ name: `S${i}`, description: "" }));
    expect(() => validateSettings({ ...valid, methodology }, [])).toThrow(ConvexError);
    try {
      validateSettings({ ...valid, inactivityMinutes: 4 }, []);
    } catch (error) {
      expect((error as ConvexError<string>).data).toBe(
        "inactivityMinutes must be an integer between 5 and 1440",
      );
    }
  });
});
