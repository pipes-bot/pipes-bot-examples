import { describe, expect, test } from "vitest";
import {
  DECLINED_CODE,
  flattenHistory,
  segmentMessages,
  summarizeHistory,
} from "./history";
import historyChunk from "../../tests/fixtures/history-chunk.json";
import historyComplete from "../../tests/fixtures/history-complete.json";
import historyDeclined from "../../tests/fixtures/history-declined.json";
import historyMedia from "../../tests/fixtures/history-media.json";

describe("DECLINED_CODE", () => {
  test("is the Meta error code for a declined history sync", () => {
    expect(DECLINED_CODE).toBe(2593109);
  });
});

describe("summarizeHistory", () => {
  test("summarizes a chunk", () => {
    expect(summarizeHistory(historyChunk)).toEqual({
      declined: false,
      progress: 40,
      phase: 0,
      chunkOrder: 1,
      messageCount: 2,
      mediaFollowUp: false,
    });
  });

  test("reports progress 100 for the last chunk", () => {
    const summary = summarizeHistory(historyComplete);
    expect(summary.progress).toBe(100);
    expect(summary.phase).toBe(1);
    expect(summary.chunkOrder).toBe(2);
    expect(summary.messageCount).toBe(4);
  });

  test("detects a declined import", () => {
    const summary = summarizeHistory(historyDeclined);
    expect(summary.declined).toBe(true);
    expect(summary.messageCount).toBe(0);
  });

  test("detects a media follow-up", () => {
    const summary = summarizeHistory(historyMedia);
    expect(summary.mediaFollowUp).toBe(true);
    expect(summary.messageCount).toBe(0);
    expect(summary.declined).toBe(false);
  });

  test("takes the max numeric progress across history items", () => {
    const summary = summarizeHistory({
      whatsapp: {
        history: [
          { metadata: { phase: 2, chunk_order: 7, progress: 30 } },
          { metadata: { progress: 80 } },
          { metadata: { progress: "99" } },
        ],
      },
    });
    expect(summary.progress).toBe(80);
    expect(summary.phase).toBe(2);
    expect(summary.chunkOrder).toBe(7);
  });

  test.each([[null], ["x"], [{ whatsapp: { history: {} } }]])(
    "returns an empty summary for %j",
    (payload) => {
      expect(summarizeHistory(payload)).toEqual({
        declined: false,
        messageCount: 0,
        mediaFollowUp: false,
      });
    },
  );
});

describe("flattenHistory", () => {
  test("flattens a chunk into rows", () => {
    const rows = flattenHistory(historyChunk);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      threadId: "16505551234",
      wamid: "wamid.HIST1",
      source: "customer",
      type: "text",
      text: "do you deliver on sundays?",
      sentAt: 1760400000000,
    });
    expect(rows[1].threadId).toBe("16505551234");
    expect(rows[1].source).toBe("phone");
    expect(rows[1].type).toBe("media_placeholder");
    expect(rows[1]).not.toHaveProperty("text");
  });

  test("skips malformed parts and keeps valid siblings", () => {
    const rows = flattenHistory({
      whatsapp: {
        history: [
          {
            threads: [
              { messages: [{ id: "wamid.NOTHREADID", timestamp: "1760400000", type: "text" }] },
              { id: "t-bad-messages", messages: "x" },
              {
                id: "t-ok",
                messages: [
                  { from: "1", timestamp: "1760400000", type: "text" },
                  { from: "1", timestamp: "1760400000", type: "text" },
                  { from: "1", id: "wamid.BADTS", timestamp: "abc", type: "text" },
                  {
                    from: "1",
                    id: "wamid.OK",
                    timestamp: "1760400000",
                    type: "text",
                    text: { body: "kept" },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(rows).toEqual([
      {
        threadId: "t-ok",
        wamid: "wamid.OK",
        source: "customer",
        type: "text",
        text: "kept",
        sentAt: 1760400000000,
      },
    ]);
  });

  test("returns [] for payloads without history", () => {
    expect(flattenHistory(null)).toEqual([]);
    expect(flattenHistory(historyMedia)).toEqual([]);
    expect(flattenHistory(historyDeclined)).toEqual([]);
  });
});

describe("segmentMessages", () => {
  const MIN = 60_000;
  const WINDOW = 120 * MIN;
  const msg = (wamid: string, sentAt: number) => ({ wamid, sentAt });

  test("keeps a gap of exactly the window in one segment", () => {
    const segments = segmentMessages([msg("a", 0), msg("b", WINDOW)], WINDOW);
    expect(segments).toEqual([[msg("a", 0), msg("b", WINDOW)]]);
  });

  test("splits when the gap exceeds the window by 1 ms", () => {
    const segments = segmentMessages([msg("a", 0), msg("b", WINDOW + 1)], WINDOW);
    expect(segments).toEqual([[msg("a", 0)], [msg("b", WINDOW + 1)]]);
  });

  test("sorts input and breaks ties by wamid", () => {
    const segments = segmentMessages(
      [msg("c", 2000), msg("b", 1000), msg("a", 1000), msg("z", 0)],
      WINDOW,
    );
    expect(segments).toEqual([[msg("z", 0), msg("a", 1000), msg("b", 1000), msg("c", 2000)]]);
  });

  test("does not mutate the input", () => {
    const input = [msg("b", 5), msg("a", 1)];
    segmentMessages(input, WINDOW);
    expect(input.map((m) => m.wamid)).toEqual(["b", "a"]);
  });

  test("returns [] for no messages", () => {
    expect(segmentMessages([], WINDOW)).toEqual([]);
  });

  test("splits the complete fixture thread into two segments", () => {
    const rows = flattenHistory(historyComplete);
    expect(segmentMessages(rows, WINDOW).map((s) => s.length)).toEqual([2, 2]);
  });
});
