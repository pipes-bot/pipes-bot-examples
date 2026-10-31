import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatter, renderExamples, replaceBlock } from "./generate-readme.ts";

const doc = (fields: string) => `---\n${fields}\n---\n\n# Body\n`;
const valid = [
  "title: With X",
  "description: Desc",
  "type: starter",
  "stack: [hono, bun]",
  "features: [webhooks, sandbox]",
].join("\n");

describe("parseFrontmatter", () => {
  it("parses valid frontmatter into arrays", () => {
    assert.deepEqual(parseFrontmatter(doc(valid), "with-x/README.md"), {
      title: "With X",
      description: "Desc",
      type: "starter",
      stack: ["hono", "bun"],
      features: ["webhooks", "sandbox"],
    });
  });

  it("throws on a missing field", () => {
    const fields = valid.replace("stack: [hono, bun]\n", "");
    assert.throws(
      () => parseFrontmatter(doc(fields), "with-x/README.md"),
      new Error('with-x/README.md: missing required field "stack"'),
    );
  });

  it("throws on an invalid type", () => {
    assert.throws(
      () => parseFrontmatter(doc(valid.replace("type: starter", "type: demo")), "with-x/README.md"),
      new Error('with-x/README.md: invalid type "demo"'),
    );
  });

  it("throws when stack or features are not arrays of strings", () => {
    assert.throws(
      () => parseFrontmatter(doc(valid.replace("[hono, bun]", "hono")), "a/README.md"),
      /a\/README\.md: "stack" must be an array of strings/,
    );
    assert.throws(
      () => parseFrontmatter(doc(valid.replace("[webhooks, sandbox]", "[webhooks, 1]")), "a/README.md"),
      /a\/README\.md: "features" must be an array of strings/,
    );
  });

  it("throws when title or description is empty", () => {
    assert.throws(
      () => parseFrontmatter(doc(valid.replace("title: With X", 'title: ""')), "a/README.md"),
      /a\/README\.md: "title" must be a non-empty string/,
    );
    assert.throws(
      () => parseFrontmatter(doc(valid.replace("description: Desc", "description: 3")), "a/README.md"),
      /a\/README\.md: "description" must be a non-empty string/,
    );
  });

  it("returns null without frontmatter", () => {
    assert.equal(parseFrontmatter("# Just a readme\n", "x/README.md"), null);
  });
});

describe("renderExamples", () => {
  const starter = {
    dir: "with-x",
    title: "With X",
    description: "Desc",
    type: "starter" as const,
    stack: ["hono", "bun"],
    features: ["webhooks", "sandbox"],
  };

  it("renders only the groups that have entries", () => {
    const out = renderExamples([starter]);
    assert.ok(out.includes("### Starters"));
    assert.ok(!out.includes("### Apps"));
    assert.ok(out.includes("| Example | Stack | pipes.bot features | Description |"));
    assert.ok(out.split("\n").includes("| [with-x](./with-x) | hono, bun | webhooks, sandbox | Desc |"));
  });

  it("sorts rows by dir and puts Starters before Apps", () => {
    const out = renderExamples([
      { ...starter, dir: "b-app", type: "app" },
      { ...starter, dir: "z-starter" },
      { ...starter, dir: "a-starter" },
    ]);
    assert.ok(out.indexOf("a-starter") < out.indexOf("z-starter"));
    assert.ok(out.indexOf("### Starters") < out.indexOf("### Apps"));
    assert.ok(out.indexOf("z-starter") < out.indexOf("### Apps"));
  });

  it("returns an empty string for no examples", () => {
    assert.equal(renderExamples([]), "");
  });
});

describe("replaceBlock", () => {
  const start = "<!-- examples:start -->";
  const end = "<!-- examples:end -->";
  const readme = `# Title\n\nIntro  text\n\n${start}\nold\n${end}\n\n## After\n\ttabbed\n`;

  it("keeps the text outside the markers byte-for-byte", () => {
    const out = replaceBlock(readme, "NEW");
    assert.ok(out.startsWith("# Title\n\nIntro  text\n\n" + start));
    assert.ok(out.endsWith(end + "\n\n## After\n\ttabbed\n"));
    assert.ok(out.includes("NEW"));
    assert.ok(!out.includes("old"));
  });

  it("is idempotent, including for an empty block", () => {
    for (const block of ["NEW", ""]) {
      const once = replaceBlock(readme, block);
      assert.equal(replaceBlock(once, block), once);
    }
    assert.ok(replaceBlock(readme, "").includes(`${start}\n\n${end}`));
  });

  it("throws when a marker is missing", () => {
    assert.throws(() => replaceBlock("no markers", "x"), /examples:start/);
    assert.throws(() => replaceBlock(`${start}\nonly start`, "x"), /examples:end/);
  });
});
