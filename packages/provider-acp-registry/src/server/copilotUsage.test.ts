import { describe, expect, it } from "@effect/vitest";
import { copilotUsageFormat } from "./copilotUsage.ts";

const parse = (lines: readonly unknown[]) => {
  const state = copilotUsageFormat.state!.initial();
  return lines.flatMap((line) => copilotUsageFormat.parseLine(JSON.stringify(line), state));
};

const start = { type: "session.start", data: { sessionId: "session-1" } };
const shutdown = (timestamp: string, outputTokens: number) => ({
  type: "session.shutdown",
  id: `shutdown-${timestamp}`,
  timestamp,
  data: {
    modelMetrics: {
      "gpt-5.6-luna": {
        usage: { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 0, outputTokens },
      },
    },
  },
});

describe("Copilot usage", () => {
  it("splits cache reads and writes out of Copilot's input count", () => {
    const [record] = parse([
      start,
      {
        type: "session.usage_record",
        id: "request-1",
        timestamp: "2026-11-16T15:40:45.272Z",
        data: {
          usage: {
            model: "claude-opus-5.5",
            inputTokens: 30394,
            outputTokens: 114,
            cacheReadTokens: 29768,
            cacheWriteTokens: 623,
            reasoningTokens: 73,
            accounting: { sourceSessionId: "session-1" },
          },
        },
      },
    ]);
    expect(record).toMatchObject({
      provider: "copilot",
      model: "claude-opus-5.5",
      sessionId: "session-1",
      totals: {
        uncachedInputTokens: 3,
        cachedInputTokens: 29768,
        cacheCreationTokens: 623,
        outputTokens: 114,
        reasoningTokens: 73,
      },
    });
  });

  it("counts each resume of an older session once from its cumulative shutdown totals", () => {
    const records = parse([
      start,
      shutdown("2026-08-27T12:42:03.730Z", 10),
      shutdown("2026-08-27T14:54:31.371Z", 10),
      shutdown("2026-08-27T15:46:27.464Z", 25),
    ]);
    expect(records.map((record) => record.totals.outputTokens)).toEqual([10, 15]);
    expect(records[0]?.totals.uncachedInputTokens).toBe(40);
    expect(records[1]?.totals.uncachedInputTokens).toBe(0);
  });

  it("ignores shutdown totals once per-request records exist", () => {
    const records = parse([
      start,
      {
        type: "session.usage_record",
        id: "request-1",
        timestamp: "2026-11-16T15:40:45.272Z",
        data: { usage: { model: "gpt-6-luna", inputTokens: 10, outputTokens: 5 } },
      },
      shutdown("2026-11-16T16:00:00.000Z", 5),
    ]);
    expect(records).toHaveLength(1);
  });
});
