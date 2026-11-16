import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  EMPTY_TOTALS,
  parseTimestampMs,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { KiroSettings } from "../settings.ts";

/** Kiro's overage price per credit, as its `/usage` command reports it (`overageRate`). */
export const KIRO_USD_PER_CREDIT = 0.04;
const KIRO_CREDITS_MODEL = "Kiro credits";

const KiroScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
type KiroScanState = typeof KiroScanState.Type;

const Line = Schema.Struct({
  id: Schema.NonEmptyString,
  timestamp: Schema.String,
  payload: Schema.Struct({
    type: Schema.String,
    promptTurnSummaries: Schema.optional(
      Schema.Array(Schema.Struct({ unit: Schema.String, usage: Schema.Unknown })),
    ),
  }),
});
const decodeLine = Schema.decodeUnknownOption(Line);
const SESSION_ID = /sess_[0-9a-f-]{36}/;

function parseRecord(parsed: unknown, state: KiroScanState): readonly UsageRecord[] {
  const decoded = decodeLine(parsed);
  if (Option.isNone(decoded)) return [];
  const line = decoded.value;
  // Kiro names the session only in some line ids, such as its session_start entry.
  const sessionId = SESSION_ID.exec(line.id)?.[0];
  if (sessionId !== undefined) state.sessionId = sessionId;
  if (line.payload.type !== "usage_summary") return [];
  const timestampMs = parseTimestampMs(line.timestamp);
  if (timestampMs === null) return [];
  const credits = (line.payload.promptTurnSummaries ?? []).reduce(
    (sum, summary) =>
      summary.unit === "credit" && typeof summary.usage === "number" && summary.usage > 0
        ? sum + summary.usage
        : sum,
    0,
  );
  if (!(credits > 0)) return [];
  return [
    {
      provider: "kiro",
      timestampMs,
      model: KIRO_CREDITS_MODEL,
      sessionId: state.sessionId,
      totals: EMPTY_TOTALS,
      reportedCostUsd: credits * KIRO_USD_PER_CREDIT,
      speed: "standard",
      dedupeKey: JSON.stringify(["kiro", line.id]),
    },
  ];
}

export const kiroUsageFormat: TranscriptUsageFormat<KiroScanState> = {
  selectFields: { id: true, timestamp: true, payload: { type: true, promptTurnSummaries: true } },
  usageMarkers: ['"usage_summary"', "sess_"],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: KiroScanState },
};

export const kiroUsageReader: ProviderUsageReader<KiroSettings, Path.Path> = {
  kind: "transcripts",
  provider: "kiro",
  format: kiroUsageFormat as TranscriptUsageFormat<unknown>,
  directories: Effect.fn("kiroUsageReader.directories")(function* () {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    return [{ dir: path.join(home, ".kiro", "sessions"), fileName: "messages.jsonl" }];
  }),
};
