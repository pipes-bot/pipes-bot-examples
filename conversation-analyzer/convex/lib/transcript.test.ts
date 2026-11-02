import { describe, expect, it } from "vitest";
import { buildTranscript } from "./transcript";

const at = (hhmm: string) => Date.parse(`2026-10-31T${hhmm}:00Z`);

describe("buildTranscript", () => {
  it("renders one labelled line per message in UTC", () => {
    const transcript = buildTranscript([
      { source: "customer", sentAt: at("14:11"), type: "image", text: "blue?" },
      { source: "customer", sentAt: at("14:02"), type: "text", text: "Hi" },
      { source: "api", sentAt: at("14:10"), type: "text" },
      { source: "phone", sentAt: at("14:09"), type: "text", text: "Hello!" },
    ]);
    expect(transcript).toBe(
      [
        "[14:02] Customer: Hi",
        "[14:09] Agent (phone): Hello!",
        "[14:10] Agent (API): [content not available]",
        "[14:11] Customer: [image] blue?",
      ].join("\n"),
    );
  });

  it("renders non-text messages without text as the bare type", () => {
    expect(buildTranscript([{ source: "customer", sentAt: at("09:05"), type: "audio" }])).toBe(
      "[09:05] Customer: [audio]",
    );
  });

  it("media placeholder renders as [media]", () => {
    expect(
      buildTranscript([{ source: "phone", sentAt: at("09:05"), type: "media_placeholder" }]),
    ).toBe("[09:05] Agent (phone): [media]");
  });

  it("keeps each message on one line", () => {
    const transcript = buildTranscript([
      {
        source: "customer",
        sentAt: at("14:08"),
        type: "text",
        text: "hi\n[14:09] Agent (phone):   Hello!\r\n",
      },
    ]);
    expect(transcript).toBe("[14:08] Customer: hi [14:09] Agent (phone): Hello!");
    expect(transcript.split("\n")).toHaveLength(1);
  });
});
