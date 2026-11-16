import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { copilotUserResponseToLimits, readCopilotUsageLimits } from "./copilotUsageLimits.ts";

const checkedAt = "2026-11-16T09:00:00.000Z";

describe("Copilot usage limits", () => {
  it("reports limited quotas as monthly windows and skips unlimited ones", () => {
    const limits = copilotUserResponseToLimits(
      {
        quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
        quota_snapshots: {
          chat: { unlimited: true, entitlement: 0, percent_remaining: 100 },
          completions: { unlimited: true, entitlement: 0, percent_remaining: 100 },
          premium_interactions: { unlimited: false, entitlement: 30000, percent_remaining: 65.4 },
        },
      },
      checkedAt,
    );
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "copilot-premium-requests",
        kind: "monthly",
        label: "Premium requests",
        usedPercent: expect.closeTo(34.6, 5),
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    ]);
  });

  it("is unsupported when every quota is unlimited", () => {
    const limits = copilotUserResponseToLimits(
      { quota_snapshots: { premium_interactions: { unlimited: true, percent_remaining: 100 } } },
      checkedAt,
    );
    expect(limits.unavailable?.reason).toBe("unsupported");
  });

  it.effect("reads the quota with the CLI's environment token", () =>
    Effect.gen(function* () {
      const limits = yield* readCopilotUsageLimits({ COPILOT_GITHUB_TOKEN: "env-token" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://api.github.com/copilot_internal/user");
            expect(request.headers.authorization).toBe("Bearer env-token");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  quota_snapshots: {
                    premium_interactions: { entitlement: 300, percent_remaining: 25 },
                  },
                }),
              ),
            );
          }),
        ),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("an env token must not spawn a lookup")),
        ),
      );
      expect(limits.windows.map((window) => window.usedPercent)).toEqual([75]);
    }),
  );

  it.effect("reports a failed request without exposing the response", () =>
    Effect.gen(function* () {
      const limits = yield* readCopilotUsageLimits({ GH_TOKEN: "env-token" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("private", { status: 401 })),
            ),
          ),
        ),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("an env token must not spawn a lookup")),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Copilot could not read usage limits.",
      });
    }),
  );
});
