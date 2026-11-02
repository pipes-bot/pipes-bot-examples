import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, listFixtures } from "./fixtures.ts";

test("loads a BYON v2 fixture", () => {
  const f = loadFixture("byon-v2/message-text");
  assert.equal(f.mode, "byon");
  assert.equal(f.body.id, "evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0");
});

test("loads a sandbox fixture", () => {
  const f = loadFixture("sandbox/message-text");
  assert.equal(f.mode, "sandbox");
  assert.equal(f.body.pipes.conversationId, "conv_xyz789");
});

test("throws on an unknown fixture", () => {
  assert.throws(() => loadFixture("nope"), /Unknown fixture: nope/);
});

test("lists every fixture and each one parses", () => {
  const names = listFixtures();
  assert.equal(names.length, 22);
  assert.deepEqual(names, [...names].sort());
  for (const name of names) assert.doesNotThrow(() => loadFixture(name));
});
