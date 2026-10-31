// Standard Webhooks verification using Web Crypto only (Convex default runtime).

const TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = "whsec_";

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error("Invalid webhook secret");
  try {
    const key = base64ToBytes(secret.slice(SECRET_PREFIX.length));
    if (key.length === 0) throw new Error("empty");
    return key;
  } catch {
    throw new Error("Invalid webhook secret");
  }
}

export async function verifyStandardWebhook(input: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  secret: string;
  nowMs?: number;
}): Promise<boolean> {
  const keyBytes = decodeSecret(input.secret);
  const { id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature) return false;
  if (!/^[0-9]{1,12}$/.test(timestamp)) return false;

  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);

  for (const entry of signature.split(/\s+/)) {
    if (!entry.startsWith("v1,")) continue;
    let expected: Uint8Array<ArrayBuffer>;
    try {
      expected = base64ToBytes(entry.slice(3));
    } catch {
      continue;
    }
    if (await crypto.subtle.verify("HMAC", key, expected, signed)) return true;
  }
  return false;
}
