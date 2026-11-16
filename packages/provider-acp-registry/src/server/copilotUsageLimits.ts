import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcess } from "effect/process";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

const CopilotQuotaSnapshot = Schema.Struct({
  unlimited: Schema.optional(Schema.Boolean),
  entitlement: Schema.optional(Schema.Number),
  percent_remaining: Schema.optional(Schema.Number),
});

const CopilotUserResponse = Schema.Struct({
  quota_reset_date_utc: Schema.optional(Schema.String),
  quota_snapshots: Schema.optional(Schema.Record(Schema.String, CopilotQuotaSnapshot)),
});

const COPILOT_QUOTA_WINDOWS = [
  { quotaId: "premium_interactions", id: "copilot-premium-requests", label: "Premium requests" },
  { quotaId: "chat", id: "copilot-chat", label: "Chat" },
  { quotaId: "completions", id: "copilot-completions", label: "Completions" },
] as const;

export function copilotUserResponseToLimits(
  response: typeof CopilotUserResponse.Type,
  checkedAt: string,
) {
  const reset = Option.fromNullishOr(response.quota_reset_date_utc).pipe(
    Option.flatMap((value) => DateTime.make(value)),
  );
  const resetsAt = Option.isSome(reset) ? DateTime.formatIso(reset.value) : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  for (const { quotaId, id, label } of COPILOT_QUOTA_WINDOWS) {
    const quota = response.quota_snapshots?.[quotaId];
    if (
      quota === undefined ||
      quota.unlimited === true ||
      !(quota.entitlement !== undefined && quota.entitlement > 0) ||
      quota.percent_remaining === undefined
    ) {
      continue;
    }
    windows.push({
      id,
      kind: "monthly",
      label,
      usedPercent: clampPercent(100 - quota.percent_remaining),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

const readCommandToken = (command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  spawnAndCollect(command, ChildProcess.make(command, args, { env })).pipe(
    Effect.timeout("5 seconds"),
    Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
    Effect.orElseSucceed(() => ""),
  );

/**
 * Finds a GitHub token for the Copilot account: Copilot's environment
 * variables, then the `gh` login. The CLI's own keychain entry is not read,
 * since macOS asks the user before any other program can read it.
 */
const resolveCopilotToken = Effect.fn("resolveCopilotToken")(function* (
  environment: NodeJS.ProcessEnv,
) {
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  const gh = yield* readCommandToken(
    "gh",
    ["auth", "token", "--hostname", "github.com"],
    // Never let gh print the token into a debug log or wait on a prompt.
    { ...environment, GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
  );
  return gh || undefined;
});

export const readCopilotUsageLimits = Effect.fn("readCopilotUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const token = yield* resolveCopilotToken(environment);
    if (!token) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in with `gh auth login`, or set `GH_TOKEN`, to see Copilot usage limits.",
      });
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(COPILOT_USER_URL).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          accept: "application/json",
          "user-agent": "t3-code",
        }),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(CopilotUserResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return copilotUserResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Copilot could not read usage limits.",
      }),
    ),
  );
});
