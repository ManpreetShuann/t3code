import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type { UsageTokenTotals } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { AcpRegistrySettings } from "../settings.ts";
import { isCopilotAcpSettings } from "./copilotAcp.ts";

const CopilotTokens = Schema.Struct({
  inputTokens: Schema.optional(Schema.Unknown),
  outputTokens: Schema.optional(Schema.Unknown),
  cacheReadTokens: Schema.optional(Schema.Unknown),
  cacheWriteTokens: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
});

const Totals = Schema.Struct({
  uncachedInputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.Number,
});

const CopilotScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  /** Per-request records make the cumulative shutdown totals redundant. */
  sawUsageRecord: Schema.mutableKey(Schema.Boolean),
  /** Cumulative shutdown totals already counted, by model. */
  counted: Schema.mutableKey(Schema.Record(Schema.String, Totals)),
});
type CopilotScanState = typeof CopilotScanState.Type;

const Entry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session.start"),
    data: Schema.Struct({ sessionId: Schema.NonEmptyString }),
  }),
  Schema.Struct({
    type: Schema.Literal("session.usage_record"),
    id: Schema.NonEmptyString,
    timestamp: Schema.String,
    data: Schema.Struct({
      usage: Schema.Struct({
        ...CopilotTokens.fields,
        model: Schema.NonEmptyString,
        accounting: Schema.optional(
          Schema.Struct({ sourceSessionId: Schema.optional(Schema.String) }),
        ),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("session.shutdown"),
    id: Schema.NonEmptyString,
    timestamp: Schema.String,
    data: Schema.Struct({
      modelMetrics: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ usage: Schema.optional(CopilotTokens) })),
      ),
    }),
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

/** Copilot's cache reads and writes are both counted inside `inputTokens`. */
function copilotTotals(usage: typeof CopilotTokens.Type): UsageTokenTotals {
  const input = tokenCount(usage.inputTokens);
  const cachedInputTokens = Math.min(input, tokenCount(usage.cacheReadTokens));
  const cacheCreationTokens = Math.min(
    input - cachedInputTokens,
    tokenCount(usage.cacheWriteTokens),
  );
  const outputTokens = tokenCount(usage.outputTokens);
  return {
    uncachedInputTokens: input - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
  };
}

function subtractTotals(current: UsageTokenTotals, previous: UsageTokenTotals | undefined) {
  if (previous === undefined) return current;
  const delta = {
    uncachedInputTokens: current.uncachedInputTokens - previous.uncachedInputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    cacheCreationTokens: current.cacheCreationTokens - previous.cacheCreationTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
  };
  // A total that went down means the counter restarted, so all of it is new.
  return Object.values(delta).some((value) => value < 0) ? current : delta;
}

function record(
  input: Omit<UsageRecord, "provider" | "reportedCostUsd" | "speed">,
): readonly UsageRecord[] {
  return totalTokens(input.totals) === 0
    ? []
    : [{ ...input, provider: "copilot", reportedCostUsd: null, speed: "standard" }];
}

function parseRecord(parsed: unknown, state: CopilotScanState): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session.start") {
    state.sessionId = entry.data.sessionId;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  if (entry.type === "session.usage_record") {
    state.sawUsageRecord = true;
    const usage = entry.data.usage;
    return record({
      timestampMs,
      model: usage.model,
      sessionId: usage.accounting?.sourceSessionId || state.sessionId,
      totals: copilotTotals(usage),
      dedupeKey: JSON.stringify(["copilot", entry.id]),
    });
  }
  // Copilot before 1.0.105 logs only cumulative per-model totals at each shutdown.
  if (state.sawUsageRecord) return [];
  return Object.entries(entry.data.modelMetrics ?? {}).flatMap(([model, metrics]) => {
    if (metrics.usage === undefined) return [];
    const current = copilotTotals(metrics.usage);
    const totals = subtractTotals(current, state.counted[model]);
    state.counted = { ...state.counted, [model]: current };
    return record({
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals,
      dedupeKey: JSON.stringify(["copilot", entry.id, model]),
    });
  });
}

export const copilotUsageFormat: TranscriptUsageFormat<CopilotScanState> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    data: { sessionId: true, usage: true, modelMetrics: true },
  },
  usageMarkers: ['"session.usage_record"', '"session.shutdown"', '"session.start"'],
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
  state: {
    initial: () => ({ sessionId: "", sawUsageRecord: false, counted: {} }),
    schema: CopilotScanState,
  },
};

export const copilotUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat as TranscriptUsageFormat<unknown>,
  // Copilot names Claude models with dots (claude-opus-5.5); the rate table uses dashes.
  rateModel: (model) => (model.startsWith("claude-") ? model.replaceAll(".", "-") : model),
  directories: Effect.fn("copilotUsageReader.directories")(function* ({ config, configured }) {
    // The unconfigured default instance still counts sessions run in the Copilot CLI itself.
    if (configured && (config === undefined || !isCopilotAcpSettings(config))) return [];
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    return [{ dir: path.join(home, ".copilot", "session-state"), fileName: "events.jsonl" }];
  }),
};
