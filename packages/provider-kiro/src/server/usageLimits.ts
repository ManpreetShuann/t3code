import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { KiroSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

import { buildKiroAcpSpawnInput } from "./acpSupport.ts";

/** Only the v2 engine answers `/usage` over ACP; v3 rejects the method. */
const KIRO_USAGE_ACP_ARGS = ["acp", "--agent-engine=v2"] as const;

const KiroUsageBreakdown = Schema.Struct({
  resourceType: Schema.String,
  displayName: Schema.optional(Schema.String),
  used: Schema.Number,
  limit: Schema.Number,
  percentage: Schema.optional(Schema.Number),
  hasLimit: Schema.optional(Schema.Boolean),
});

const KiroUsageCommandResult = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.optional(
    Schema.Struct({
      billingCycleReset: Schema.optional(Schema.String),
      usageBreakdowns: Schema.optional(Schema.Array(KiroUsageBreakdown)),
    }),
  ),
});
const decodeKiroUsageCommandResult = Schema.decodeUnknownEffect(KiroUsageCommandResult);

export function kiroUsageToLimits(result: typeof KiroUsageCommandResult.Type, checkedAt: string) {
  const reset = Option.fromNullishOr(result.data?.billingCycleReset).pipe(
    Option.flatMap((value) => DateTime.make(value)),
  );
  const resetsAt = Option.isSome(reset) ? DateTime.formatIso(reset.value) : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  for (const breakdown of result.data?.usageBreakdowns ?? []) {
    if (breakdown.hasLimit === false || !(breakdown.limit > 0)) continue;
    windows.push({
      id: `kiro-${breakdown.resourceType.toLowerCase()}`,
      kind: "monthly",
      label: breakdown.displayName?.trim() || breakdown.resourceType,
      usedPercent: clampPercent(breakdown.percentage ?? (breakdown.used / breakdown.limit) * 100),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

// The usage command needs a session, so the probe deletes the empty one it opened.
const deleteKiroSession = Effect.fn("deleteKiroSession")(
  function* (settings: KiroSettings, sessionId: string, environment: NodeJS.ProcessEnv) {
    const command = settings.binaryPath || "kiro-cli";
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["chat", "--delete-session", sessionId, "--session-source", "v2"],
      { env: environment },
    );
    yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  },
  (effect) => effect.pipe(Effect.timeout("10 seconds"), Effect.ignore),
);

export const readKiroUsageLimits = Effect.fn("readKiroUsageLimits")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ReturnType<typeof kiroUsageToLimits>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const cwd = yield* HostProcess.WorkingDirectory;
  const sessionIdRef = yield* Ref.make<string | undefined>(undefined);
  return yield* Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        cwd,
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        spawn: { ...buildKiroAcpSpawnInput(settings, cwd, environment), args: KIRO_USAGE_ACP_ARGS },
      }),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    const { sessionId } = yield* runtime.start();
    yield* Ref.set(sessionIdRef, sessionId);
    return yield* runtime.request("_kiro.dev/commands/execute", {
      sessionId,
      command: { command: "usage", args: {} },
    });
  }).pipe(
    Effect.scoped,
    // Runs after the scope closes, so Kiro has exited and cannot rewrite the session.
    Effect.ensuring(
      Ref.get(sessionIdRef).pipe(
        Effect.flatMap((sessionId) =>
          sessionId === undefined
            ? Effect.void
            : deleteKiroSession(settings, sessionId, environment),
        ),
      ),
    ),
    Effect.flatMap(decodeKiroUsageCommandResult),
    Effect.map((result) => kiroUsageToLimits(result, checkedAt)),
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Kiro could not read usage limits.",
      }),
    ),
  );
});
