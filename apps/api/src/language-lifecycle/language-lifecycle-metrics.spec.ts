import {
  LanguageLifecycleMetrics,
  consoleLanguageLifecycleLogger,
  sanitizeLogFields,
} from "./language-lifecycle-metrics";
import { LanguageScanPlan } from "./language-lifecycle-types";

function plan(overrides: Partial<LanguageScanPlan> = {}): LanguageScanPlan {
  return {
    status: "partial",
    analyze: new Map([["a.sol", "solidity"]]),
    skipped: [
      { path: "secret/tenant/x.js", language: "javascript", reason: "retired" },
      { path: "y.js", language: "javascript", reason: "retired" },
    ],
    warnings: [{ language: "vyper", files: 3, message: "m" }],
    fingerprint: "f",
    ...overrides,
  };
}

describe("LanguageLifecycleMetrics", () => {
  it("counts plans, skipped files, and deprecated files", () => {
    const metrics = new LanguageLifecycleMetrics();
    metrics.recordPlan(plan());
    metrics.recordPlan(plan({ status: "complete", skipped: [], warnings: [] }));
    metrics.recordPin("created");
    metrics.recordPin("reused");
    metrics.recordPin("reused");
    metrics.recordPublish("forced");
    metrics.recordViolation("SKIPPED_DEPRECATION");
    metrics.recordError("STORE_UNAVAILABLE");
    expect(metrics.snapshot()).toEqual({
      pinsCreated: 1,
      pinsReused: 2,
      plans: { partial: 1, complete: 1 },
      filesSkipped: { "javascript:retired": 2 },
      deprecatedFiles: { vyper: 3 },
      policyPublishes: { forced: 1 },
      violations: { SKIPPED_DEPRECATION: 1 },
      errors: { STORE_UNAVAILABLE: 1 },
    });
  });

  it("exports Prometheus text without paths or tenant ids", () => {
    const metrics = new LanguageLifecycleMetrics();
    metrics.recordPlan(plan());
    const text = metrics.toPrometheus(
      {
        version: "1.0.0",
        digest: "d",
        publishedAt: 0,
        languages: [
          {
            language: "vyper",
            stage: "supported",
            extensions: [],
            deprecatedAt: "2026-07-01",
            sunsetAt: "2027-01-31",
          },
        ],
      },
      "2026-10-18",
    );
    expect(text).toContain(
      'gasguard_language_files_skipped_total{language="javascript",reason="retired"} 2',
    );
    expect(text).toContain('gasguard_language_plans_total{status="partial"} 1');
    expect(text).toContain(
      'gasguard_language_stage{language="vyper",stage="deprecated"} 1',
    );
    expect(text).not.toMatch(/secret|tenant|\.js"/);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("sanitizeLogFields", () => {
  it("drops payload, path and credential keys and non-primitive values", () => {
    expect(
      sanitizeLogFields({
        tenantId: "t",
        count: 2,
        ok: true,
        filePath: "x.sol",
        paths: "a,b",
        sourceCode: "contract X {}",
        apiKey: "k",
        authorization: "Bearer x",
        nested: { a: 1 },
        list: [1],
        missing: undefined,
      }),
    ).toEqual({ tenantId: "t", count: 2, ok: true });
  });

  it("truncates long strings", () => {
    const { reason } = sanitizeLogFields({ reason: "x".repeat(500) });
    expect(String(reason)).toHaveLength(201);
  });
});

describe("consoleLanguageLifecycleLogger", () => {
  it("writes one sanitized JSON line, info to stdout and others to stderr", () => {
    const out = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const err = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      consoleLanguageLifecycleLogger.log("info", "e", { a: 1, token: "t" });
      consoleLanguageLifecycleLogger.log("warn", "w", {});
      expect(JSON.parse(out.mock.calls[0][0])).toEqual({
        level: "info",
        component: "language-lifecycle",
        event: "e",
        a: 1,
      });
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
