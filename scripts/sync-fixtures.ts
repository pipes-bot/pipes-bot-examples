import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Fixtures published at docs.pipes.bot. The other files in fixtures/ are
// hand-built from docs examples and are not touched here.
const DOCS_FILES = [
  "message-contact-request",
  "message-image",
  "message-text-bsuid-only",
  "message-text-parent-bsuid",
  "message-text-username-with-phone",
  "message-text",
  "status-delivered-bsuid",
  "status-failed",
  "system-user-changed-number",
  "system-user-changed-user-id",
  "template-status-update",
];

const BASE_URL = "https://docs.pipes.bot/fixtures/byon-v2";
const DIR = join(import.meta.dirname, "..", "fixtures", "byon-v2");

let failed = false;

for (const name of DOCS_FILES) {
  const url = `${BASE_URL}/${name}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = JSON.stringify(await res.json(), null, 2) + "\n";
    const path = join(DIR, `${name}.json`);
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {}
    if (current === next) {
      console.log(`unchanged ${name}`);
    } else {
      writeFileSync(path, next);
      console.log(`updated ${name}`);
    }
  } catch (err) {
    console.error(`failed ${name}: ${(err as Error).message}`);
    failed = true;
  }
}

if (failed) process.exit(1);
