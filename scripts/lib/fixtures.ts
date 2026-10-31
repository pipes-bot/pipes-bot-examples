import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Mode = "sandbox" | "byon";

export type Fixture = { name: string; mode: Mode; body: any };

const ROOT = join(import.meta.dirname, "..", "..", "fixtures");

const FOLDERS: Record<string, Mode> = { "byon-v2": "byon", sandbox: "sandbox" };

export function listFixtures(): string[] {
  return Object.keys(FOLDERS)
    .flatMap((folder) =>
      readdirSync(join(ROOT, folder))
        .filter((file) => file.endsWith(".json"))
        .map((file) => `${folder}/${file.slice(0, -".json".length)}`),
    )
    .sort();
}

export function loadFixture(name: string): Fixture {
  const folder = name.split("/")[0];
  if (!listFixtures().includes(name)) throw new Error(`Unknown fixture: ${name}`);
  const body = JSON.parse(readFileSync(join(ROOT, `${name}.json`), "utf8"));
  return { name, mode: FOLDERS[folder], body };
}
