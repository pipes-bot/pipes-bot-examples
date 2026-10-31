import { loadFixture } from "./lib/fixtures.ts";
import { signSandbox, signStandardWebhook } from "./lib/sign.ts";

export type SimulateOptions = {
  fixture: string; // e.g. "byon-v2/message-text"
  url: string;
  secret: string;
  times?: number; // default 1; same id and body on every attempt
  idSuffix?: string; // appended to the envelope id (byon) and every message id before signing
  text?: string; // replaces the body of every text message
  badSignature?: boolean; // sign with "wrong-secret" (sandbox) / a different whsec_ key (byon)
  noSignature?: boolean; // omit signature headers
  extraSignature?: boolean; // byon: "v1,<bogus> v1,<valid>"
  timestampOffset?: number; // seconds added to now for webhook-timestamp (byon)
  rawBody?: string; // send this body verbatim instead of the fixture
  transform?: (body: any) => any; // applied after idSuffix/text, before signing
};

export type SimulateResult = { status: number; body: string };

const WRONG_BYON_SECRET = `whsec_${Buffer.alloc(24).toString("base64")}`;
const BOGUS_SIGNATURE = `v1,${Buffer.alloc(32, 1).toString("base64")}`;

function messagesOf(body: any, mode: "sandbox" | "byon"): any[] {
  const messages =
    mode === "sandbox" ? body?.entry?.[0]?.changes?.[0]?.value?.messages : body?.whatsapp?.messages;
  return Array.isArray(messages) ? messages : [];
}

export async function simulate(opts: SimulateOptions): Promise<SimulateResult[]> {
  const fixture = loadFixture(opts.fixture);
  const { mode } = fixture;
  const suffix = opts.idSuffix ?? "";
  const fallbackId = `evt_fixture_${opts.fixture.split("/").pop()!.replaceAll("-", "_")}${suffix}`;

  let payload: string;
  let webhookId = fallbackId;
  if (opts.rawBody !== undefined) {
    payload = opts.rawBody;
  } else {
    let body = structuredClone(fixture.body);
    if (suffix && typeof body.id === "string") body.id += suffix;
    for (const message of messagesOf(body, mode)) {
      if (suffix && typeof message.id === "string") message.id += suffix;
      if (opts.text !== undefined && message.type === "text" && message.text) {
        message.text.body = opts.text;
      }
    }
    if (opts.transform) body = opts.transform(body);
    if (typeof body?.id === "string") webhookId = body.id;
    payload = JSON.stringify(body);
  }

  const results: SimulateResult[] = [];
  for (let attempt = 0; attempt < (opts.times ?? 1); attempt++) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (mode === "sandbox") {
      if (!opts.noSignature) {
        headers["X-Pipes-Signature"] = signSandbox(
          payload,
          opts.badSignature ? "wrong-secret" : opts.secret,
        );
      }
    } else {
      // Refreshed on every attempt, as pipes.bot does on retries.
      const timestamp = Math.floor(Date.now() / 1000) + (opts.timestampOffset ?? 0);
      headers["webhook-id"] = webhookId;
      headers["webhook-timestamp"] = String(timestamp);
      if (!opts.noSignature) {
        const signature = signStandardWebhook(
          webhookId,
          timestamp,
          payload,
          opts.badSignature ? WRONG_BYON_SECRET : opts.secret,
        );
        headers["webhook-signature"] = opts.extraSignature ? `${BOGUS_SIGNATURE} ${signature}` : signature;
      }
    }
    const response = await fetch(opts.url, { method: "POST", headers, body: payload });
    results.push({ status: response.status, body: await response.text() });
  }
  return results;
}

function parseArgs(argv: string[]) {
  const flags = new Set(["bad-signature", "no-signature", "extra-signature"]);
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (flags.has(arg.slice(2))) bools.add(arg.slice(2));
    else values.set(arg.slice(2), argv[++i]);
  }
  return { values, bools, positional };
}

async function main() {
  const { values, bools, positional } = parseArgs(process.argv.slice(2));
  if (positional.length !== 1) {
    console.error(
      "Usage: simulate-webhook <fixture> [--url U] [--secret S] [--times N] [--text T] " +
        "[--bad-signature] [--no-signature] [--extra-signature] [--timestamp-offset SECONDS]",
    );
    process.exit(1);
  }
  const offset = values.get("timestamp-offset");
  const results = await simulate({
    fixture: positional[0],
    url: values.get("url") ?? "http://localhost:3000/webhook",
    secret: values.get("secret") ?? process.env.PIPES_WEBHOOK_SECRET ?? "",
    times: values.has("times") ? Number(values.get("times")) : undefined,
    text: values.get("text"),
    badSignature: bools.has("bad-signature"),
    noSignature: bools.has("no-signature"),
    extraSignature: bools.has("extra-signature"),
    timestampOffset: offset === undefined ? undefined : Number(offset),
  });
  for (const result of results) console.log(`${result.status} ${result.body}`);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
