import { describe, expect, it } from "@effect/vitest";
import { kiroUsageFormat, KIRO_USD_PER_CREDIT } from "./usage.ts";

const parse = (lines: readonly unknown[]) => {
  const state = kiroUsageFormat.state!.initial();
  return lines.flatMap((line) => kiroUsageFormat.parseLine(JSON.stringify(line), state));
};

const usageSummary = (id: string, usage: number) => ({
  id: `${id}-usage`,
  timestamp: "2026-11-16T08:03:35.023Z",
  payload: {
    type: "usage_summary",
    promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage }],
  },
});

describe("Kiro usage", () => {
  it("prices each turn's credits and attributes later turns to the session Kiro names", () => {
    const records = parse([
      usageSummary("turn-1", 0.5),
      {
        id: "session_start_sess_81419ca1-63ac-4937-8a66-0e23fcac4170_default-v2",
        timestamp: "2026-11-16T08:03:35.039Z",
        payload: { type: "session_start" },
      },
      usageSummary("turn-2", 0.25),
    ]);
    expect(records.map((record) => record.reportedCostUsd)).toEqual([
      0.5 * KIRO_USD_PER_CREDIT,
      0.25 * KIRO_USD_PER_CREDIT,
    ]);
    expect(records.map((record) => record.sessionId)).toEqual([
      "",
      "sess_81419ca1-63ac-4937-8a66-0e23fcac4170",
    ]);
  });

  it("skips turns that used no credits", () => {
    expect(parse([usageSummary("turn-1", 0)])).toEqual([]);
  });
});
