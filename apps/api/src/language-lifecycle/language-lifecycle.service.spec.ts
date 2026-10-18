import { readFileSync } from "fs";
import * as path from "path";
import { LanguageLifecycleConfig } from "./language-lifecycle-config";
import {
  LanguageLifecycleLogFields,
  LanguageLifecycleLogLevel,
  LanguageLifecycleLogger,
} from "./language-lifecycle-metrics";
import { InMemoryLanguageLifecycleStore } from "./language-lifecycle-store";
import {
  LanguageLifecycleError,
  LanguageLifecyclePolicy,
} from "./language-lifecycle-types";
import { LanguageLifecycleService } from "./language-lifecycle.service";

const TODAY = Date.UTC(2026, 9, 18, 12);
const governed = JSON.parse(
  readFileSync(
    path.join(__dirname, "__fixtures__", "governed-policy.json"),
    "utf8",
  ),
) as LanguageLifecyclePolicy;

class CapturingLogger implements LanguageLifecycleLogger {
  readonly entries: {
    level: string;
    event: string;
    fields: LanguageLifecycleLogFields;
  }[] = [];
  log(
    level: LanguageLifecycleLogLevel,
    event: string,
    fields: LanguageLifecycleLogFields,
  ): void {
    this.entries.push({ level, event, fields });
  }
  text(): string {
    return JSON.stringify(this.entries);
  }
}

let store: InMemoryLanguageLifecycleStore;
let logger: CapturingLogger;
let now: number;

function service(config: Partial<LanguageLifecycleConfig> = {}) {
  return new LanguageLifecycleService({
    store,
    logger,
    clock: () => now,
    config,
  });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: "LanguageLifecycleError",
    code,
  });
}

/** Governed policy, but with javascript deprecated rather than retired. */
function publishable(version = "1.0.0"): LanguageLifecyclePolicy {
  return {
    version,
    languages: governed.languages.map((entry) =>
      entry.language === "javascript"
        ? {
            language: "javascript",
            stage: "deprecated",
            extensions: entry.extensions,
            deprecatedAt: "2026-10-18",
            sunsetAt: "2027-03-01",
            replacement: "typescript",
          }
        : entry,
    ),
  };
}

beforeEach(() => {
  store = new InMemoryLanguageLifecycleStore();
  logger = new CapturingLogger();
  now = TODAY;
});

describe("getPolicy", () => {
  it("falls back to the built-in default, which supports every language", async () => {
    const policy = await service().getPolicy();
    expect(policy.version).toBe("0.0.0");
    expect(policy.publishedAt).toBe(0);
    expect(policy.languages.every((l) => l.stage === "supported")).toBe(true);
  });
});

describe("publishPolicy", () => {
  it("publishes a valid policy and records it in the history", async () => {
    const svc = service();
    const published = await svc.publishPolicy(publishable());
    expect(published.result).toBe("published");
    expect(published.policy).toMatchObject({
      version: "1.0.0",
      publishedAt: TODAY,
    });
    expect(published.policy.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await svc.getPolicy()).digest).toBe(published.policy.digest);
    expect(await svc.listPolicyHistory()).toHaveLength(1);
    expect(svc.metrics.snapshot().policyPublishes).toEqual({ published: 1 });
  });

  it("is idempotent for the policy that is already current", async () => {
    const svc = service();
    const first = await svc.publishPolicy(publishable());
    now += 1000;
    const again = await svc.publishPolicy(publishable());
    expect(again.result).toBe("unchanged");
    expect(again.policy).toEqual(first.policy);
    expect(await svc.listPolicyHistory()).toHaveLength(1);
  });

  it("rejects an invalid policy without touching the store", async () => {
    await expectCode(
      service().publishPolicy({ version: "1.0.0", languages: [] }),
      "INVALID_POLICY",
    );
    expect(await store.getPolicy()).toBeUndefined();
  });

  it("rejects retiring a language the default supported, listing the violation", async () => {
    // The governed fixture retires javascript, which the default supports.
    const error = await service()
      .publishPolicy(governed)
      .catch((e: LanguageLifecycleError) => e);
    expect(error).toBeInstanceOf(LanguageLifecycleError);
    expect((error as LanguageLifecycleError).code).toBe("TRANSITION_REJECTED");
    expect((error as LanguageLifecycleError).retryable).toBe(false);
    expect((error as LanguageLifecycleError).violations).toEqual([
      expect.objectContaining({
        code: "SKIPPED_DEPRECATION",
        language: "javascript",
      }),
    ]);
  });

  it("allows a forced publish with a reason and keeps an audit record", async () => {
    const svc = service();
    const published = await svc.publishPolicy(governed, {
      force: true,
      reason: "  javascript analyzer removed in engine 3.0  ",
    });
    expect(published.overridden.map((v) => v.code)).toEqual([
      "SKIPPED_DEPRECATION",
    ]);
    expect(published.policy.reason).toBe(
      "javascript analyzer removed in engine 3.0",
    );
    expect(published.policy.overriddenViolations).toEqual([
      "SKIPPED_DEPRECATION",
    ]);
    expect(svc.metrics.snapshot().policyPublishes).toEqual({ forced: 1 });
    expect(
      logger.entries.find((e) => e.event === "policy_published")?.level,
    ).toBe("warn");
  });

  it("requires a reason to force", async () => {
    await expectCode(
      service().publishPolicy(governed, { force: true }),
      "INVALID_INPUT",
    );
    await expectCode(
      service().publishPolicy(governed, { force: true, reason: " " }),
      "INVALID_INPUT",
    );
  });

  it("never lets force bypass a non-increasing version", async () => {
    const svc = service();
    await svc.publishPolicy(publishable("1.0.0"));
    const changed = publishable("1.0.0");
    changed.languages = changed.languages.filter((l) => l.language !== "move");
    await expectCode(
      svc.publishPolicy(changed, { force: true, reason: "r" }),
      "TRANSITION_REJECTED",
    );
  });

  it("reports a concurrent publish as a retryable CONFLICT", async () => {
    const svc = service();
    await svc.publishPolicy(publishable("1.0.0"));
    const real = store.putPolicy.bind(store);
    jest.spyOn(store, "putPolicy").mockImplementationOnce(async (policy) => {
      // Another operator publishes between our read and our write.
      const current = await store.getPolicy();
      await real(
        { ...current!, version: "1.0.5", digest: "other" },
        current!.digest,
      );
      return real(policy, current!.digest);
    });
    const error = await svc
      .publishPolicy(publishable("1.1.0"))
      .catch((e: LanguageLifecycleError) => e);
    expect(error).toMatchObject({ code: "CONFLICT", retryable: true });
  });
});

describe("tenant settings", () => {
  it("stores sorted, unique opt-ins per tenant", async () => {
    const svc = service();
    const settings = await svc.setPreviewOptIns("tenant-a", [
      "move",
      "cairo",
      "move",
    ]);
    expect(settings).toEqual({
      tenantId: "tenant-a",
      previewOptIns: ["cairo", "move"],
      updatedAt: TODAY,
    });
    expect((await svc.getTenantSettings("tenant-b")).previewOptIns).toEqual([]);
  });

  it.each([
    ["an empty tenant", "", ["cairo"]],
    ["a non-array", "tenant-a", "cairo" as unknown as string[]],
    ["a bad slug", "tenant-a", ["Cairo"]],
  ])("rejects %s", async (_name, tenantId, languages) => {
    await expectCode(
      service().setPreviewOptIns(tenantId, languages),
      "INVALID_INPUT",
    );
  });

  it("rejects more opt-ins than maxLanguages", async () => {
    await expectCode(
      service({ maxLanguages: 1 }).setPreviewOptIns("t", ["a", "b"]),
      "INVALID_INPUT",
    );
  });

  it("describes the policy for one tenant only", async () => {
    const svc = service();
    await svc.publishPolicy(governed, { force: true, reason: "test" });
    await svc.setPreviewOptIns("tenant-a", ["cairo"]);
    const a = await svc.describeForTenant("tenant-a");
    const b = await svc.describeForTenant("tenant-b");
    const cairo = (view: typeof a) =>
      view.languages.find((l) => l.language === "cairo");
    expect(cairo(a)).toMatchObject({
      action: "analyze",
      reason: "preview_opt_in",
    });
    expect(cairo(b)).toMatchObject({
      action: "skip",
      reason: "preview_not_enabled",
    });
    expect(JSON.stringify(b)).not.toContain("tenant-a");
  });
});

describe("resolveForScan", () => {
  it("creates a pin once and reuses it on retry", async () => {
    const svc = service();
    const first = await svc.resolveForScan({ tenantId: "t", scanId: "s" });
    expect(first.status).toBe("created");
    expect(first.pin.asOf).toBe("2026-10-18");
    const retry = await svc.resolveForScan({ tenantId: "t", scanId: "s" });
    expect(retry.status).toBe("reused");
    expect(retry.pin).toEqual(first.pin);
    expect(svc.metrics.snapshot()).toMatchObject({
      pinsCreated: 1,
      pinsReused: 1,
    });
  });

  it("keeps a pinned scan's decisions when the policy, date and opt-ins change", async () => {
    const svc = service();
    const first = await svc.resolveForScan({ tenantId: "t", scanId: "s" });
    await svc.publishPolicy(governed, { force: true, reason: "test" });
    await svc.setPreviewOptIns("t", ["cairo"]);
    now += 400 * 24 * 60 * 60 * 1000;
    const retry = await svc.resolveForScan({
      tenantId: "t",
      scanId: "s",
      asOf: "2030-01-01",
    });
    expect(retry.pin).toEqual(first.pin);
  });

  it("gives the same fingerprint for the same commit date, config and policy", async () => {
    const svc = service();
    await svc.publishPolicy(governed, { force: true, reason: "test" });
    const a = await svc.resolveForScan({
      tenantId: "t",
      scanId: "s1",
      asOf: "2026-10-15",
    });
    now += 3 * 24 * 60 * 60 * 1000;
    const b = await svc.resolveForScan({
      tenantId: "t",
      scanId: "s2",
      asOf: "2026-10-15",
    });
    expect(b.pin.fingerprint).toBe(a.pin.fingerprint);
  });

  it("isolates pins between tenants with colliding scan ids", async () => {
    const svc = service();
    await svc.publishPolicy(governed, { force: true, reason: "test" });
    await svc.setPreviewOptIns("tenant-a", ["cairo"]);
    const a = await svc.resolveForScan({
      tenantId: "tenant-a",
      scanId: "scan-1",
    });
    const b = await svc.resolveForScan({
      tenantId: "tenant-b",
      scanId: "scan-1",
    });
    expect(b.status).toBe("created");
    expect(b.pin.fingerprint).not.toBe(a.pin.fingerprint);
    expect(b.pin.tenantId).toBe("tenant-b");
  });

  it("uses the winner's pin when a concurrent attempt pins first", async () => {
    const svc = service();
    const winner = await svc.resolveForScan({ tenantId: "t", scanId: "race" });
    jest.spyOn(store, "getPin").mockResolvedValueOnce(undefined);
    const loser = await svc.resolveForScan({ tenantId: "t", scanId: "race" });
    expect(loser).toEqual({ pin: winner.pin, status: "reused" });
  });

  it.each([
    [{ tenantId: "", scanId: "s" }],
    [{ tenantId: "t", scanId: "x".repeat(201) }],
    [{ tenantId: "t", scanId: "bad\nid" }],
    [{ tenantId: "t", scanId: "s", asOf: "2026-13-01" }],
    [undefined as unknown as { tenantId: string; scanId: string }],
  ])("rejects %j as INVALID_INPUT", async (request) => {
    await expectCode(service().resolveForScan(request), "INVALID_INPUT");
  });

  it("maps store failures to retryable STORE_UNAVAILABLE without leaking details", async () => {
    const svc = service();
    jest
      .spyOn(store, "getPin")
      .mockRejectedValueOnce(
        new Error("ECONNREFUSED postgres://admin:hunter2@db"),
      );
    const error = await svc
      .resolveForScan({ tenantId: "t", scanId: "s" })
      .catch((e: LanguageLifecycleError) => e);
    expect(error).toMatchObject({ code: "STORE_UNAVAILABLE", retryable: true });
    expect((error as Error).message).not.toContain("hunter2");
    expect(logger.text()).not.toContain("hunter2");
    expect(svc.metrics.snapshot().errors).toEqual({ STORE_UNAVAILABLE: 1 });
    expect(await store.getPin("t", "s")).toBeUndefined();
  });

  describe("kill switch", () => {
    it("analyzes every language for new scans when disabled", async () => {
      await service().publishPolicy(governed, { force: true, reason: "test" });
      const disabled = service({
        enabled: false,
        unlistedLanguageAction: "skip",
      });
      const { pin } = await disabled.resolveForScan({
        tenantId: "t",
        scanId: "s",
      });
      expect(pin.decisions.every((d) => d.action === "analyze")).toBe(true);
      expect(pin.unlistedAction).toBe("analyze");
    });

    it("still honours pins created while enabled", async () => {
      await service().publishPolicy(governed, { force: true, reason: "test" });
      const enabledPin = (
        await service().resolveForScan({ tenantId: "t", scanId: "s" })
      ).pin;
      const retry = await service({ enabled: false }).resolveForScan({
        tenantId: "t",
        scanId: "s",
      });
      expect(retry.pin).toEqual(enabledPin);
    });
  });
});

describe("planScan", () => {
  it("logs counts and codes but never file paths", async () => {
    const svc = service();
    await svc.publishPolicy(governed, { force: true, reason: "test" });
    const { pin } = await svc.resolveForScan({ tenantId: "t", scanId: "s" });
    const plan = svc.planScan(
      pin,
      new Map([
        ["private/customer-secret/Vault.vy", "vyper"],
        ["private/customer-secret/old.js", "javascript"],
      ]),
    );
    expect(plan.status).toBe("partial");
    const entry = logger.entries.find((e) => e.event === "scan_planned")!;
    expect(entry.level).toBe("warn");
    expect(entry.fields).toMatchObject({
      status: "partial",
      analyzedCount: 1,
      skippedCount: 1,
      deprecatedLanguages: "vyper",
    });
    expect(logger.text()).not.toContain("customer-secret");
    expect(svc.metrics.snapshot().filesSkipped).toEqual({
      "javascript:retired": 1,
    });
  });

  it("counts invalid input as an error", async () => {
    const svc = service({ maxFilesPerScan: 1 });
    const { pin } = await svc.resolveForScan({ tenantId: "t", scanId: "s" });
    expect(() =>
      svc.planScan(
        pin,
        new Map([
          ["a.sol", "solidity"],
          ["b.sol", "solidity"],
        ]),
      ),
    ).toThrow(LanguageLifecycleError);
    expect(svc.metrics.snapshot().errors).toEqual({ INVALID_INPUT: 1 });
  });
});

describe("checkCoverage", () => {
  it("compares the current policy with analyzer languages", async () => {
    const svc = service();
    await svc.publishPolicy(governed, { force: true, reason: "test" });
    const issues = await svc.checkCoverage([
      "solidity",
      "rust",
      "soroban",
      "typescript",
    ]);
    expect(issues.map((i) => `${i.kind}:${i.language}`)).toEqual([
      "no_analyzer:cairo",
      "no_analyzer:move",
      "no_analyzer:vyper",
    ]);
  });
});

describe("purgeExpiredPins", () => {
  it("removes pins older than the retention period", async () => {
    const svc = service({ pinRetentionMs: 1000 });
    await svc.resolveForScan({ tenantId: "t", scanId: "old" });
    now += 2000;
    await svc.resolveForScan({ tenantId: "t", scanId: "new" });
    expect(await svc.purgeExpiredPins()).toBe(1);
    expect(store.pinCount()).toBe(1);
  });
});
