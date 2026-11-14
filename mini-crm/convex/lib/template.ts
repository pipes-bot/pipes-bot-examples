export type TemplateSpec = { name: string; language: string; bodyParams: string[] };

const NAME_RE = /^[a-z0-9_]{1,512}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const MAX_PARAMS = 20;
const MAX_PARAM_LENGTH = 1024;

export function validateTemplate(raw: {
  name: string;
  language: string;
  bodyParams?: string[];
}): TemplateSpec | null {
  const bodyParams = raw.bodyParams ?? [];
  if (!NAME_RE.test(raw.name) || !LANGUAGE_RE.test(raw.language)) return null;
  if (bodyParams.length > MAX_PARAMS) return null;
  for (const p of bodyParams) {
    if (p.length < 1 || p.length > MAX_PARAM_LENGTH) return null;
    if (/[\n\t]/.test(p) || / {5,}/.test(p)) return null;
  }
  return { name: raw.name, language: raw.language, bodyParams };
}

export function templateText(t: TemplateSpec): string {
  const head = `[template ${t.name}]`;
  return t.bodyParams.length > 0 ? `${head} ${t.bodyParams.join(", ")}` : head;
}

export function passthroughBody(
  t: TemplateSpec,
  poolNumberId: string,
  contact: { waId?: string; userId?: string },
): Record<string, unknown> {
  const template: Record<string, unknown> = {
    name: t.name,
    language: { code: t.language },
  };
  if (t.bodyParams.length > 0) {
    template.components = [
      { type: "body", parameters: t.bodyParams.map((text) => ({ type: "text", text })) },
    ];
  }
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    poolNumberId,
    type: "template",
    template,
  };
  if (contact.waId) body.to = contact.waId;
  else body.recipient = contact.userId;
  return body;
}
