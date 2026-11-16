import { describe, expect, it } from "@effect/vitest";
import { kiroUsageToLimits } from "./usageLimits.ts";

const checkedAt = "2026-11-16T09:00:00.000Z";

describe("Kiro usage limits", () => {
  it("reports each limited breakdown as a monthly window that resets with the billing cycle", () => {
    const limits = kiroUsageToLimits(
      {
        success: true,
        data: {
          billingCycleReset: "2026-12-01",
          usageBreakdowns: [
            {
              resourceType: "CREDIT",
              displayName: "Credits",
              used: 629.07,
              limit: 2000,
              percentage: 31.4535,
              hasLimit: true,
            },
            { resourceType: "AGENTIC_REQUEST", used: 3, limit: 0, hasLimit: false },
          ],
        },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "kiro-credit",
        kind: "monthly",
        label: "Credits",
        usedPercent: 31.4535,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    ]);
  });

  it("is unsupported when the command reports no limited usage", () => {
    expect(kiroUsageToLimits({ success: false }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
  });
});
