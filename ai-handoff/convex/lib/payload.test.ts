import { describe, expect, test } from "vitest";
import {
  contactName,
  contentOf,
  list,
  senderOf,
  statusRecipientOf,
  waTimestampMs,
} from "./payload";
import messageImage from "../../tests/fixtures/message-image.json";
import messageBsuidOnly from "../../tests/fixtures/message-text-bsuid-only.json";
import statusFailed from "../../tests/fixtures/status-failed.json";
import statusDeliveredBsuid from "../../tests/fixtures/status-delivered-bsuid.json";

describe("list", () => {
  test("returns [] for non-arrays", () => {
    expect(list(null)).toEqual([]);
    expect(list({})).toEqual([]);
  });
  test("returns arrays as is", () => {
    expect(list([1, 2])).toEqual([1, 2]);
  });
});

describe("waTimestampMs", () => {
  test("converts seconds to ms", () => {
    expect(waTimestampMs("1749416383", 5)).toBe(1749416383000);
    expect(waTimestampMs(1749416383, 5)).toBe(1749416383000);
  });
  test("falls back on invalid values", () => {
    expect(waTimestampMs("abc", 5)).toBe(5);
    expect(waTimestampMs("1234567890123", 5)).toBe(5);
    expect(waTimestampMs(undefined, 5)).toBe(5);
  });
});

describe("senderOf", () => {
  test("ignores an empty from", () => {
    expect(senderOf({ from: "", from_user_id: "US.1" })).toEqual({
      userId: "US.1",
    });
  });
  test("reads both ids from a fixture", () => {
    expect(senderOf(messageImage.whatsapp.messages[0])).toEqual({
      waId: "16505551234",
      userId: "US.13491208655302741918",
    });
  });
});

describe("statusRecipientOf", () => {
  test("prefers recipient_id", () => {
    expect(statusRecipientOf(statusFailed.whatsapp.statuses[0])).toBe(
      "16505551234",
    );
  });
  test("falls back to recipient_user_id", () => {
    expect(statusRecipientOf(statusDeliveredBsuid.whatsapp.statuses[0])).toBe(
      "US.13491208655302741918",
    );
  });
});

describe("contentOf", () => {
  test("uses the image caption", () => {
    expect(contentOf(messageImage.whatsapp.messages[0])).toEqual({
      type: "image",
      text: "Do you have this one in blue?",
    });
  });
  test("returns only the type for sticker", () => {
    expect(contentOf({ type: "sticker" })).toEqual({ type: "sticker" });
  });
});

describe("contactName", () => {
  test("matches by user id", () => {
    expect(
      contactName(messageBsuidOnly.whatsapp, {
        userId: "US.13491208655302741918",
      }),
    ).toBe("Sheena Nelson");
  });
});
