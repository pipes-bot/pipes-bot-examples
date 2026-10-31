import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { startMockApi, type MockApi, type MockCall } from "./mock-pipes-api.ts";
import { simulate, type SimulateOptions } from "./simulate-webhook.ts";
import type { Mode } from "./lib/fixtures.ts";

type StarterConfig = { name: string; cwd: string; command: string[]; path: string; port: number };

type Expected = { path: string; body: Record<string, unknown> };

type Step = {
  fixture: string;
  options?: Partial<SimulateOptions>;
  status: number[]; // one per attempt
  failNext?: boolean; // make the mock fail the next send call before this step
};

type SmokeCase = {
  name: string;
  mode: Mode;
  fixture: string;
  options?: Partial<SimulateOptions>; // url/secret/idSuffix are filled by the runner
  status: number[];
  sends: Expected[]; // expected calls, partial deep match, in order
  steps?: Step[]; // multi-request cases; replaces fixture/options/status
};

const ROOT = join(import.meta.dirname, "..");

const STARTERS: StarterConfig[] = [
  {
    name: "with-hono-bun",
    cwd: join(ROOT, "with-hono-bun"),
    command: ["bun", "run", "index.ts"],
    path: "/webhook",
    port: 3101,
  },
  {
    name: "with-fastapi",
    cwd: join(ROOT, "with-fastapi"),
    command: ["uv", "run", "main.py"],
    path: "/webhook",
    port: 3102,
  },
  {
    name: "with-nextjs-route-handler",
    cwd: join(ROOT, "with-nextjs-route-handler"),
    command: ["pnpm", "exec", "next", "dev", "--port", "3103"],
    path: "/api/webhook",
    port: 3103,
  },
];

const CREDENTIALS: Record<Mode, { key: string; secret: string }> = {
  sandbox: { key: "pk_smoke_test_key", secret: "smoke-secret-0123456789" },
  byon: { key: "ak_smoke_test_key", secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" },
};

const S = "/v1/messages/send";
const A = "/v1/messages/app/send";
const UNICODE = "Olá 👋 ação";
const V2_TEXT = "Does it come in another color?";
const BSUID = "US.13491208655302741918";

const IGNORED_BYON = [
  "message-image",
  "message-contact-request",
  "smb-message-echo",
  "status-delivered-bsuid",
  "status-failed",
  "system-user-changed-number",
  "system-user-changed-user-id",
  "template-status-update",
  "number-onboarded",
  "test-webhook",
];

const CASES: SmokeCase[] = [
  {
    name: "text",
    mode: "sandbox",
    fixture: "sandbox/message-text",
    status: [200],
    sends: [{ path: S, body: { conversationId: "conv_xyz789", text: "Echo: Hello from WhatsApp!" } }],
  },
  { name: "image", mode: "sandbox", fixture: "sandbox/message-image", status: [200], sends: [] },
  { name: "test-connection", mode: "sandbox", fixture: "sandbox/test-connection", status: [200], sends: [] },
  {
    name: "bad-signature",
    mode: "sandbox",
    fixture: "sandbox/message-text",
    options: { badSignature: true },
    status: [401],
    sends: [],
  },
  {
    name: "signed-null",
    mode: "sandbox",
    fixture: "sandbox/message-text",
    options: { rawBody: "null" },
    status: [400],
    sends: [],
  },
  {
    name: "missing-id",
    mode: "sandbox",
    fixture: "sandbox/message-text",
    options: {
      transform: (body) => {
        for (const message of body.entry[0].changes[0].value.messages) delete message.id;
        return body;
      },
    },
    status: [200],
    sends: [],
  },
  {
    name: "duplicate",
    mode: "sandbox",
    fixture: "sandbox/message-text",
    options: { times: 2 },
    status: [200, 200],
    sends: [{ path: S, body: { text: "Echo: Hello from WhatsApp!" } }],
  },
  {
    name: "unicode",
    mode: "sandbox",
    fixture: "sandbox/message-text",
    options: { text: UNICODE },
    status: [200],
    sends: [{ path: S, body: { text: `Echo: ${UNICODE}` } }],
  },
  {
    name: "text",
    mode: "byon",
    fixture: "byon-v2/message-text",
    status: [200],
    sends: [{ path: A, body: { poolNumberId: "pn_abc123", to: "16505551234", text: `Echo: ${V2_TEXT}` } }],
  },
  {
    name: "username-with-phone",
    mode: "byon",
    fixture: "byon-v2/message-text-username-with-phone",
    status: [200],
    sends: [{ path: A, body: { to: "16505551234" } }],
  },
  {
    name: "bsuid-only",
    mode: "byon",
    fixture: "byon-v2/message-text-bsuid-only",
    status: [200],
    sends: [{ path: A, body: { to: BSUID } }],
  },
  {
    name: "parent-bsuid",
    mode: "byon",
    fixture: "byon-v2/message-text-parent-bsuid",
    status: [200],
    sends: [{ path: A, body: { to: BSUID } }],
  },
  ...IGNORED_BYON.map(
    (name): SmokeCase => ({
      name: `ignored-${name}`,
      mode: "byon",
      fixture: `byon-v2/${name}`,
      status: [200],
      sends: [],
    }),
  ),
  {
    name: "bad-signature",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: { badSignature: true },
    status: [401],
    sends: [],
  },
  {
    name: "stale-timestamp",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: { timestampOffset: -600 },
    status: [401],
    sends: [],
  },
  {
    name: "no-signature",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: { noSignature: true },
    status: [401],
    sends: [],
  },
  {
    name: "non-json",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: { rawBody: "not json" },
    status: [400],
    sends: [],
  },
  {
    name: "signed-null",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: { rawBody: "null" },
    status: [400],
    sends: [],
  },
  {
    name: "duplicate",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: { times: 2 },
    status: [200, 200],
    sends: [{ path: A, body: { text: `Echo: ${V2_TEXT}` } }],
  },
  {
    name: "multi-signature",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: { extraSignature: true },
    status: [200],
    sends: [{ path: A, body: { text: `Echo: ${V2_TEXT}` } }],
  },
  {
    name: "unicode",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: { text: UNICODE },
    status: [200],
    sends: [{ path: A, body: { text: `Echo: ${UNICODE}` } }],
  },
  {
    name: "multi-message",
    mode: "byon",
    fixture: "byon-v2/message-text",
    options: {
      transform: (body) => {
        const first = body.whatsapp.messages[0];
        body.whatsapp.messages.push({
          ...structuredClone(first),
          id: `${first.id}_2`,
          text: { ...first.text, body: "Second" },
        });
        return body;
      },
    },
    status: [200],
    sends: [
      { path: A, body: { text: `Echo: ${V2_TEXT}` } },
      { path: A, body: { text: "Echo: Second" } },
    ],
  },
  {
    // The first send fails with a 500 (still recorded); the starter must stay up and answer the next message.
    name: "send-failure",
    mode: "byon",
    fixture: "byon-v2/message-text",
    status: [200],
    steps: [
      { fixture: "byon-v2/message-text", status: [200], failNext: true },
      { fixture: "byon-v2/message-text-bsuid-only", status: [200] },
    ],
    sends: [
      { path: A, body: { to: "16505551234", text: `Echo: ${V2_TEXT}` } },
      { path: A, body: { to: BSUID } },
    ],
  },
];

const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const SETTLE_MS = 1000;
const KILL_GRACE_MS = 3000;
const LOG_TAIL_LINES = 20;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- process handling -------------------------------------------------------------------------

type Running = {
  child: ChildProcess;
  exited: () => boolean;
  failure: () => string | null; // spawn error or exit description
  tail: () => string;
  stop: () => Promise<void>;
};

const running = new Set<Running>();

function startProcess(config: StarterConfig, env: Record<string, string>): Running {
  const [cmd, ...args] = config.command;
  const lines: string[] = [];
  let exitInfo: string | null = null;
  let hasExited = false;

  const child = spawn(cmd, args, {
    cwd: config.cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const collect = (chunk: Buffer) => {
    lines.push(...chunk.toString("utf8").split("\n"));
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => {
    exitInfo = `could not spawn ${config.command.join(" ")}: ${error.message}`;
    hasExited = true;
  });
  child.on("exit", (code, signal) => {
    if (!hasExited) exitInfo = `process exited (${signal ? `signal ${signal}` : `code ${code}`})`;
    hasExited = true;
  });

  const groupAlive = () => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  };

  const handle: Running = {
    child,
    exited: () => hasExited,
    failure: () => exitInfo,
    tail: () =>
      lines
        .join("\n")
        .trimEnd()
        .split("\n")
        .slice(-LOG_TAIL_LINES)
        .map((line) => `    | ${line}`)
        .join("\n"),
    stop: async () => {
      signalGroup("SIGTERM");
      const deadline = Date.now() + KILL_GRACE_MS;
      while (groupAlive() && Date.now() < deadline) await sleep(100);
      if (groupAlive()) signalGroup("SIGKILL");
      running.delete(handle);
    },
  };
  running.add(handle);
  return handle;
}

async function waitUntilReady(proc: Running, url: string): Promise<string | null> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exited()) return proc.failure() ?? "process exited";
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(2000),
      });
      return null; // any HTTP response means ready
    } catch {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  return `not ready after ${STARTUP_TIMEOUT_MS / 1000}s`;
}

// --- assertions -------------------------------------------------------------------------------

// Every key in `expected` must deep-equal the actual value; extra keys in `actual` are fine.
function partialMatch(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, i) => partialMatch(item, actual[i]))
    );
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      partialMatch(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return isDeepStrictEqual(expected, actual);
}

function checkSends(expected: Expected[], calls: MockCall[], apiKey: string): string[] {
  const problems: string[] = [];
  if (calls.length !== expected.length) {
    problems.push(`expected ${expected.length} send call(s), got ${calls.length}`);
  }
  const bearer = `Bearer ${apiKey}`;
  calls.forEach((call, i) => {
    if (call.authorization !== bearer) {
      problems.push(`call ${i + 1} authorization: expected ${bearer}, got ${call.authorization}`);
    }
  });
  expected.forEach((want, i) => {
    const got = calls[i];
    if (!got) return;
    if (got.path !== want.path) problems.push(`call ${i + 1} path: expected ${want.path}, got ${got.path}`);
    if (!partialMatch(want.body, got.body)) {
      problems.push(
        `call ${i + 1} body: expected ${JSON.stringify(want.body)} (partial), got ${JSON.stringify(got.body)}`,
      );
    }
  });
  if (problems.length > 0) {
    problems.push(`actual calls: ${JSON.stringify(calls.map(({ path, body }) => ({ path, body })))}`);
  }
  return problems;
}

// --- running cases ----------------------------------------------------------------------------

async function runCase(
  testCase: SmokeCase,
  index: number,
  starter: StarterConfig,
  mock: MockApi,
): Promise<string[]> {
  const { key, secret } = CREDENTIALS[testCase.mode];
  const url = `http://127.0.0.1:${starter.port}${starter.path}`;
  const steps: Step[] = testCase.steps ?? [
    { fixture: testCase.fixture, options: testCase.options, status: testCase.status },
  ];

  mock.clear();
  const problems: string[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    if (step.failNext) mock.failNext();
    const idSuffix = stepIndex === 0 ? `_${index}` : `_${index}_${stepIndex}`;
    const results = await simulate({ ...step.options, fixture: step.fixture, url, secret, idSuffix });
    await sleep(SETTLE_MS);
    const statuses = results.map((result) => result.status);
    if (!isDeepStrictEqual(statuses, step.status)) {
      const label = steps.length > 1 ? `step ${stepIndex + 1} ` : "";
      problems.push(`${label}status: expected [${step.status}], got [${statuses}]`);
    }
  }
  problems.push(...checkSends(testCase.sends, mock.calls(), key));
  return problems;
}

async function runStarterMode(
  starter: StarterConfig,
  mode: Mode,
  results: { passed: number; total: number },
): Promise<void> {
  const label = (name: string) => `${starter.name} ${mode} ${name}`;
  const fail = (name: string, details: string[]) => {
    results.total++;
    // Startup failures read as one line: `FAIL <starter> <mode> startup: <reason>`.
    const [first, ...rest] = name === "startup" ? [`startup: ${details[0]}`, ...details.slice(1)] : [name, ...details];
    console.log(`FAIL ${starter.name} ${mode} ${first}`);
    for (const line of rest) console.log(`  ${line.split("\n").join("\n  ")}`);
  };

  if (!existsSync(starter.cwd)) {
    fail("startup", ["folder not found"]);
    return;
  }

  const { key, secret } = CREDENTIALS[mode];
  const cases = CASES.map((testCase, index) => ({ testCase, index })).filter(
    ({ testCase }) => testCase.mode === mode,
  );
  const mock = await startMockApi(0);
  let proc: Running | undefined;
  try {
    proc = startProcess(starter, {
      PIPES_API_KEY: key,
      PIPES_WEBHOOK_SECRET: secret,
      PIPES_API_BASE_URL: mock.url,
      PORT: String(starter.port),
    });
    const startupError = await waitUntilReady(proc, `http://127.0.0.1:${starter.port}${starter.path}`);
    if (startupError) {
      fail("startup", [startupError, proc.tail()]);
      return;
    }

    for (const [position, { testCase, index }] of cases.entries()) {
      let problems: string[];
      try {
        problems = await runCase(testCase, index, starter, mock);
      } catch (error) {
        problems = [`error: ${error instanceof Error ? error.message : String(error)}`];
      }
      if (proc.exited()) {
        problems.push(`${proc.failure() ?? "starter process exited"} during this case`, proc.tail());
        fail(testCase.name, problems);
        for (const { testCase: skipped } of cases.slice(position + 1)) {
          fail(skipped.name, ["not run: starter process exited"]);
        }
        return;
      }
      if (problems.length === 0) {
        results.total++;
        results.passed++;
        console.log(`PASS ${label(testCase.name)}`);
      } else {
        fail(testCase.name, problems);
      }
    }
  } finally {
    if (proc) await proc.stop();
    await mock.close();
  }
}

export async function runSmoke(names?: string[]): Promise<boolean> {
  const selected = names && names.length > 0 ? names : STARTERS.map((starter) => starter.name);
  const unknown = selected.filter((name) => !STARTERS.some((starter) => starter.name === name));
  if (unknown.length > 0) {
    console.error(
      `Unknown starter(s): ${unknown.join(", ")}. Known: ${STARTERS.map((starter) => starter.name).join(", ")}`,
    );
    return false;
  }

  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\nreceived ${signal}, stopping starters...`);
    Promise.all([...running].map((proc) => proc.stop())).finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results = { passed: 0, total: 0 };
  try {
    for (const starter of STARTERS.filter((candidate) => selected.includes(candidate.name))) {
      for (const mode of ["sandbox", "byon"] as const) {
        await runStarterMode(starter, mode, results);
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  console.log(`\n${results.passed}/${results.total} passed`);
  return results.passed === results.total;
}

if (process.argv[1] === import.meta.filename) {
  runSmoke(process.argv.slice(2)).then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    },
  );
}
