import WebSocket from "ws";
import { createDedup, modeFromKey, repliesFor, resultLine } from "./bot.ts";
import type { Mode } from "./bot.ts";

// Load .env if there is one (Node does not read it on its own).
try {
  process.loadEnvFile();
} catch {}

let mode: Mode;
try {
  mode = modeFromKey(process.env.PIPES_API_KEY);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const apiKey = process.env.PIPES_API_KEY!;
const baseUrl = (process.env.PIPES_API_BASE_URL ?? "https://api.pipes.bot").replace(/\/+$/, "");
// https -> wss (http -> ws). pk_ opens a user-scoped connection, ak_ an App-scoped one.
const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?apiKey=${encodeURIComponent(apiKey)}`;

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;
const isNew = createDedup();
let attempt = 0; // consecutive failed connections; reset when the server sends `connected`
let stopping = false;

function connect() {
  const ws = new WebSocket(wsUrl);
  let alive = true;
  let ping: NodeJS.Timeout | undefined;

  ws.on("open", () => {
    alive = true;
    // Keep the connection open through proxies and load balancers; drop it if the server stops answering.
    ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
  });
  ws.on("pong", () => (alive = true));

  ws.on("message", (raw) => {
    let frame: any;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return console.log("skipped invalid-frame -");
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return console.log("skipped invalid-frame -");
    }
    if (frame.type === "connected") {
      attempt = 0;
      return console.log(`${mode} connected (scope: ${frame.scope})`);
    }
    const result = resultLine(frame);
    if (result) return result.ok ? console.log(result.line) : console.error(result.line);

    for (const reply of repliesFor(frame, mode, isNew, console.log)) {
      try {
        ws.send(JSON.stringify(reply));
      } catch (err) {
        console.error("send failed:", err);
      }
    }
  });

  ws.on("error", (err) => console.error(`connection error: ${err.message}`));
  ws.on("close", (code) => {
    clearInterval(ping);
    if (stopping) return;
    const delay = Math.min(1000 * 2 ** attempt++, MAX_BACKOFF_MS);
    console.log(`disconnected (${code}), reconnecting in ${delay / 1000}s`);
    setTimeout(connect, delay);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    process.exit(0);
  });
}

console.log(`connecting to ${baseUrl.replace(/^http/, "ws")}/ws (${mode})`);
connect();
