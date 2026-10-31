import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startMockApi, type MockApi } from "./mock-pipes-api.ts";

const headers = { "Content-Type": "application/json", Authorization: "Bearer pk_x" };

describe("mock pipes.bot API", () => {
  let api: MockApi;
  before(async () => {
    api = await startMockApi(0);
  });
  after(() => api.close());

  const post = (path: string, body: unknown) =>
    fetch(api.url + path, { method: "POST", headers, body: JSON.stringify(body) });

  it("answers both send paths and records calls", async () => {
    api.clear();
    const sandbox = await post("/v1/messages/send", { conversationId: "c1", text: "hi" });
    assert.equal(sandbox.status, 200);
    assert.deepEqual(await sandbox.json(), {
      success: true,
      messageId: "wamid.mock_1",
      conversationId: "c1",
    });
    const byon = await post("/v1/messages/app/send", { to: "5511999990000", type: "text" });
    assert.equal(byon.status, 200);
    assert.deepEqual(await byon.json(), {
      messageId: "wamid.mock_2",
      contacts: [{ input: "5511999990000", wa_id: "5511999990000" }],
    });
    assert.deepEqual(api.calls(), [
      {
        path: "/v1/messages/send",
        authorization: "Bearer pk_x",
        body: { conversationId: "c1", text: "hi" },
      },
      {
        path: "/v1/messages/app/send",
        authorization: "Bearer pk_x",
        body: { to: "5511999990000", type: "text" },
      },
    ]);
  });

  it("failNext fails one send, still records it, then recovers", async () => {
    api.clear();
    api.failNext();
    const failed = await post("/v1/messages/send", { conversationId: "c2" });
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "mock failure" });
    const ok = await post("/v1/messages/send", { conversationId: "c2" });
    assert.equal(ok.status, 200);
    assert.equal(api.calls().length, 2);
  });

  it("records raw string bodies and a missing authorization header", async () => {
    api.clear();
    const response = await fetch(api.url + "/v1/messages/send", { method: "POST", body: "not json" });
    assert.equal(response.status, 200);
    assert.deepEqual(api.calls(), [
      { path: "/v1/messages/send", authorization: null, body: "not json" },
    ]);
  });

  it("clear empties calls", async () => {
    await post("/v1/messages/send", {});
    assert.ok(api.calls().length > 0);
    api.clear();
    assert.deepEqual(api.calls(), []);
  });

  it("returns 404 for unknown paths and wrong methods", async () => {
    assert.equal((await post("/v1/unknown", {})).status, 404);
    assert.equal((await fetch(api.url + "/v1/messages/send")).status, 404);
    assert.deepEqual(api.calls(), []);
  });

  it("exposes control endpoints without recording them", async () => {
    api.clear();
    await post("/v1/messages/send", { conversationId: "c3" });
    const listed = await (await fetch(api.url + "/__calls")).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].body.conversationId, "c3");
    assert.equal((await fetch(api.url + "/__fail-next", { method: "POST" })).status, 200);
    assert.equal((await post("/v1/messages/send", {})).status, 500);
    assert.equal((await fetch(api.url + "/__calls", { method: "DELETE" })).status, 200);
    assert.deepEqual(api.calls(), []);
  });
});
