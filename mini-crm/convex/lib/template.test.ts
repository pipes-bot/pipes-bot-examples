import { expect, test } from "vitest";
import { passthroughBody, templateText, validateTemplate } from "./template";

const spec = { name: "order_confirmation", language: "en_US", bodyParams: ["Maria", "ORD-4521"] };

test("valid template", () => {
  expect(validateTemplate(spec)).toEqual(spec);
  expect(validateTemplate({ name: "hello", language: "pt_BR" })).toEqual({ name: "hello", language: "pt_BR", bodyParams: [] });
  expect(validateTemplate({ name: "hi", language: "en" })).not.toBeNull();
});

test.each([
  { name: "Order", language: "en_US" },
  { name: "", language: "en_US" },
  { name: "ok", language: "english" },
  { name: "ok", language: "en_us" },
  { name: "ok", language: "en_US", bodyParams: [""] },
  { name: "ok", language: "en_US", bodyParams: ["a\nb"] },
  { name: "ok", language: "en_US", bodyParams: ["a\tb"] },
  { name: "ok", language: "en_US", bodyParams: ["a     b"] },
  { name: "ok", language: "en_US", bodyParams: ["x".repeat(1025)] },
  { name: "ok", language: "en_US", bodyParams: Array(21).fill("x") },
])("invalid template %o", (raw) => expect(validateTemplate(raw)).toBeNull());

test("readable text", () => {
  expect(templateText(spec)).toBe("[template order_confirmation] Maria, ORD-4521");
  expect(templateText({ ...spec, bodyParams: [] })).toBe("[template order_confirmation]");
});

test("passthrough body to a phone number", () => {
  expect(passthroughBody(spec, "pn_1", { waId: "5511900000000", userId: "BR.1" })).toEqual({
    messaging_product: "whatsapp",
    poolNumberId: "pn_1",
    type: "template",
    to: "5511900000000",
    template: {
      name: "order_confirmation",
      language: { code: "en_US" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Maria" }, { type: "text", text: "ORD-4521" }] }],
    },
  });
});

test("passthrough body to a BSUID, no params", () => {
  const body = passthroughBody({ ...spec, bodyParams: [] }, "pn_1", { userId: "US.13491208655302741918" });
  expect(body.recipient).toBe("US.13491208655302741918");
  expect(body).not.toHaveProperty("to");
  expect((body.template as Record<string, unknown>).components).toBeUndefined();
});
