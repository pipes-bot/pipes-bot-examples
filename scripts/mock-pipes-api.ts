import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type MockCall = { path: string; authorization: string | null; body: any };
export type MockApi = {
  url: string;
  calls(): MockCall[];
  clear(): void;
  failNext(): void; // the next send call returns 500 and is still recorded
  close(): Promise<void>;
};

const SEND_PATHS = new Set(["/v1/messages/send", "/v1/messages/app/send"]);

function parseBody(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function startMockApi(
  port = 0,
  onCall?: (call: MockCall) => void,
): Promise<MockApi> {
  let calls: MockCall[] = [];
  let failNext = false;
  let counter = 0;

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (path === "/__calls" && req.method === "GET") return json(200, calls);
    if (path === "/__calls" && req.method === "DELETE") {
      calls = [];
      return json(200, { ok: true });
    }
    if (path === "/__fail-next" && req.method === "POST") {
      failNext = true;
      return json(200, { ok: true });
    }
    if (req.method !== "POST" || !SEND_PATHS.has(path)) return json(404, { error: "not found" });

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = parseBody(Buffer.concat(chunks).toString("utf8"));
    const call: MockCall = { path, authorization: req.headers.authorization ?? null, body };
    calls.push(call);
    onCall?.(call);

    if (failNext) {
      failNext = false;
      return json(500, { error: "mock failure" });
    }
    const messageId = `wamid.mock_${++counter}`;
    if (path === "/v1/messages/send") {
      return json(200, { success: true, messageId, conversationId: body?.conversationId });
    }
    return json(200, { messageId, contacts: [{ input: body?.to, wa_id: body?.to }] });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const { port: actualPort } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    calls: () => [...calls],
    clear: () => {
      calls = [];
    },
    failNext: () => {
      failNext = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4010;
  const api = await startMockApi(port, (call) =>
    console.log(`${call.path} ${JSON.stringify(call.body)}`),
  );
  console.log(`mock pipes.bot API listening on ${api.url}`);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
