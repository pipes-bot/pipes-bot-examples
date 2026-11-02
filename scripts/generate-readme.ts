import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export type ExampleMeta = {
  title: string;
  description: string;
  type: "starter" | "app";
  stack: string[];
  features: string[];
};
export type ExampleEntry = ExampleMeta & { dir: string };

const REQUIRED = ["title", "description", "type", "stack", "features"] as const;
const KNOWN_FEATURES = new Set([
  "webhooks",
  "websocket",
  "sandbox",
  "byon-v2",
  "coexistence",
  "echoes",
  "embedded-signup",
  "templates",
  "media",
  "mcp",
  "history-import",
  "contacts-sync",
]);
const START = "<!-- examples:start -->";
const END = "<!-- examples:end -->";
const SKIP_DIRS = new Set(["node_modules", "scripts", "fixtures", "docs"]);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function parseFrontmatter(markdown: string, source: string): ExampleMeta | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  const data = (parse(match[1]) ?? {}) as Record<string, unknown>;

  for (const field of REQUIRED) {
    if (data[field] === undefined || data[field] === null) {
      throw new Error(`${source}: missing required field "${field}"`);
    }
  }
  for (const field of ["title", "description"] as const) {
    if (!isNonEmptyString(data[field])) {
      throw new Error(`${source}: "${field}" must be a non-empty string`);
    }
  }
  if (data.type !== "starter" && data.type !== "app") {
    throw new Error(`${source}: invalid type "${String(data.type)}"`);
  }
  for (const field of ["stack", "features"] as const) {
    if (!isStringArray(data[field])) {
      throw new Error(`${source}: "${field}" must be an array of strings`);
    }
  }
  const features = data.features as string[];
  for (const feature of features) {
    if (!KNOWN_FEATURES.has(feature)) {
      console.error(`warning: ${source}: unknown feature "${feature}"`);
    }
  }
  return {
    title: data.title as string,
    description: data.description as string,
    type: data.type,
    stack: data.stack as string[],
    features,
  };
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function renderTable(heading: string, entries: ExampleEntry[]): string {
  const rows = [...entries]
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
    .map(
      (e) =>
        `| [${e.dir}](./${e.dir}) | ${cell(e.stack.join(", "))} | ${cell(e.features.join(", "))} | ${cell(e.description)} |`,
    );
  return [
    `### ${heading}`,
    "",
    "| Example | Stack | pipes.bot features | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function renderExamples(examples: ExampleEntry[]): string {
  const groups: [string, ExampleEntry["type"]][] = [
    ["Starters", "starter"],
    ["Apps", "app"],
  ];
  return groups
    .map(([heading, type]) => ({ heading, entries: examples.filter((e) => e.type === type) }))
    .filter((g) => g.entries.length > 0)
    .map((g) => renderTable(g.heading, g.entries))
    .join("\n\n");
}

export function replaceBlock(readme: string, block: string): string {
  const start = readme.indexOf(START);
  if (start === -1) throw new Error(`README.md: missing marker ${START}`);
  const end = readme.indexOf(END, start + START.length);
  if (end === -1) throw new Error(`README.md: missing marker ${END}`);
  const middle = block === "" ? "\n\n" : `\n\n${block}\n\n`;
  return readme.slice(0, start + START.length) + middle + readme.slice(end);
}

export function collectExamples(root: string): ExampleEntry[] {
  const entries: ExampleEntry[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".") || SKIP_DIRS.has(dirent.name)) continue;
    const file = join(root, dirent.name, "README.md");
    if (!existsSync(file)) continue;
    const meta = parseFrontmatter(readFileSync(file, "utf8"), `${dirent.name}/README.md`);
    if (meta) entries.push({ dir: dirent.name, ...meta });
  }
  return entries;
}

if (process.argv[1] === import.meta.filename) {
  const root = join(import.meta.dirname, "..");
  const readmePath = join(root, "README.md");
  const current = readFileSync(readmePath, "utf8");
  const next = replaceBlock(current, renderExamples(collectExamples(root)));
  if (process.argv.includes("--check")) {
    if (next !== current) {
      console.error("README.md is out of date. Run pnpm readme.");
      process.exit(1);
    }
  } else if (next !== current) {
    writeFileSync(readmePath, next);
    console.log("README.md updated");
  }
}
