/**
 * Supported-language lifecycle policy.
 *
 * Operators publish a versioned policy that places each language in a
 * lifecycle stage (preview, supported, deprecated, retired), optionally with
 * scheduled deprecation and sunset dates. Tenants may opt into preview
 * languages. Workers call `resolveForScan` before analysing a repository and
 * `planScan` to split its files into what will be analyzed and what is skipped
 * and why.
 *
 * Determinism: a scan's language decisions are pinned the first time it
 * resolves, including the day the scheduled dates were evaluated at, so a
 * retry always analyzes the same languages. Pass `asOf` (for example the
 * commit date) to make re-runs of the same commit reproduce exactly; the
 * pin's `fingerprint` belongs in any cache key for scan results.
 *
 * Backward compatibility: until a policy is published the built-in default
 * marks every engine language as supported, and languages a policy does not
 * list are analyzed unless `unlistedLanguageAction` is `skip`. Disabling the
 * policy (`LANGUAGE_LIFECYCLE_ENABLED=false`) analyzes everything again for
 * new scans while honouring existing pins.
 */

import {
  DEFAULT_LANGUAGE_LIFECYCLE_CONFIG,
  LanguageLifecycleConfig,
  resolveLanguageLifecycleConfig,
} from "./language-lifecycle-config";
import {
  LanguageLifecycleLogger,
  LanguageLifecycleMetrics,
  consoleLanguageLifecycleLogger,
  sanitizeLogFields,
} from "./language-lifecycle-metrics";
import {
  CoverageIssue,
  DEFAULT_LANGUAGE_POLICY,
  buildPin,
  checkPolicyCoverage,
  checkPolicyTransition,
  compareStrings,
  evaluateDecisions,
  isValidDay,
  normalizePolicy,
  planScan,
  policyDigest,
  requireIdentifier,
  requireLanguage,
  utcDay,
} from "./language-lifecycle-policy";
import { LanguageLifecycleStore } from "./language-lifecycle-store";
import {
  LanguageDecision,
  LanguageLifecycleError,
  LanguageScanPin,
  LanguageScanPlan,
  PolicyViolation,
  StoredLanguagePolicy,
  TenantLanguageSettings,
} from "./language-lifecycle-types";

const MAX_REASON_LENGTH = 500;

export interface LanguageLifecycleServiceOptions {
  store: LanguageLifecycleStore;
  config?: Partial<LanguageLifecycleConfig>;
  logger?: LanguageLifecycleLogger;
  metrics?: LanguageLifecycleMetrics;
  clock?: () => number;
}

export interface PublishOptions {
  /**
   * Publish despite transition violations other than VERSION_NOT_INCREASED.
   * Requires `reason`, which is kept in the policy history.
   */
  force?: boolean;
  reason?: string;
}

export interface PublishResult {
  policy: StoredLanguagePolicy;
  /** `unchanged` when the same policy was already current (idempotent). */
  result: "published" | "unchanged";
  /** Violations that `force` overrode; empty for a clean publish. */
  overridden: PolicyViolation[];
}

export interface ScanLanguageRequest {
  tenantId: string;
  scanId: string;
  /**
   * UTC day to evaluate scheduled dates at, `YYYY-MM-DD`. Defaults to today.
   * Ignored when the scan is already pinned.
   */
  asOf?: string;
}

export interface ScanLanguageResolution {
  pin: LanguageScanPin;
  /** `reused` when the scan was already pinned (a retry). */
  status: "created" | "reused";
}

/** Tenant-facing view of the policy. Never names other tenants. */
export interface TenantLanguageView {
  policyVersion: string;
  asOf: string;
  languages: LanguageDecision[];
  previewOptIns: string[];
}

export class LanguageLifecycleService {
  readonly config: LanguageLifecycleConfig;
  readonly metrics: LanguageLifecycleMetrics;
  private readonly store: LanguageLifecycleStore;
  private readonly logger: LanguageLifecycleLogger;
  private readonly clock: () => number;

  constructor(options: LanguageLifecycleServiceOptions) {
    this.config = resolveLanguageLifecycleConfig(
      options.config ?? DEFAULT_LANGUAGE_LIFECYCLE_CONFIG,
    );
    this.store = options.store;
    // Sanitize here as well as in the default logger, so a custom logger can
    // never receive more than identifiers, versions, counts, and codes.
    const logger = options.logger ?? consoleLanguageLifecycleLogger;
    this.logger = {
      log: (level, event, fields) =>
        logger.log(level, event, sanitizeLogFields(fields)),
    };
    this.metrics = options.metrics ?? new LanguageLifecycleMetrics();
    this.clock = options.clock ?? Date.now;
  }

  /**
   * The current policy, or the built-in default when none was published.
   *
   * @throws LanguageLifecycleError STORE_UNAVAILABLE
   */
  getPolicy(): Promise<StoredLanguagePolicy> {
    return this.guard("get_policy", () => this.currentPolicy());
  }

  /**
   * Validate and publish a new policy. Publishing the policy that is already
   * current is a no-op, so retrying a publish after a timeout is safe.
   *
   * @throws LanguageLifecycleError INVALID_INPUT, INVALID_POLICY,
   *   TRANSITION_REJECTED, CONFLICT or STORE_UNAVAILABLE
   */
  publishPolicy(
    input: unknown,
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    return this.guard("publish_policy", async () => {
      const reason = this.optionalReason(options.reason);
      if (options.force && reason === undefined) {
        throw new LanguageLifecycleError(
          "INVALID_INPUT",
          "a forced publish requires a reason",
        );
      }
      const next = normalizePolicy(input, this.config);
      const digest = policyDigest(next);
      const stored = await this.store.getPolicy();
      const current = stored ?? defaultStoredPolicy();
      if (stored && stored.digest === digest) {
        this.metrics.recordPublish("unchanged");
        return { policy: stored, result: "unchanged", overridden: [] };
      }

      const asOf = utcDay(this.clock());
      const violations = checkPolicyTransition(
        current,
        next,
        asOf,
        this.config.minDeprecationNoticeDays,
      );
      for (const violation of violations) {
        this.metrics.recordViolation(violation.code);
      }
      const unforceable = violations.filter(
        (v) => v.code === "VERSION_NOT_INCREASED",
      );
      if (violations.length > 0 && (!options.force || unforceable.length > 0)) {
        throw new LanguageLifecycleError(
          "TRANSITION_REJECTED",
          `policy ${next.version} was rejected: ${violations
            .map((v) => v.message)
            .join("; ")}`,
          violations,
        );
      }

      const policy: StoredLanguagePolicy = {
        ...next,
        digest,
        publishedAt: this.clock(),
      };
      if (reason !== undefined) {
        policy.reason = reason;
      }
      if (violations.length > 0) {
        policy.overriddenViolations = violations.map((v) => v.code);
      }
      const write = await this.store.putPolicy(policy, stored?.digest ?? null);
      if (write === "conflict") {
        throw new LanguageLifecycleError(
          "CONFLICT",
          "the policy changed while publishing; re-read it and try again",
        );
      }
      const kind = violations.length > 0 ? "forced" : "published";
      this.metrics.recordPublish(kind);
      this.logger.log(
        violations.length > 0 ? "warn" : "info",
        "policy_published",
        {
          policyVersion: policy.version,
          previousVersion: current.version,
          policyDigest: digest,
          languageCount: policy.languages.length,
          forced: violations.length > 0,
          overridden: violations.map((v) => v.code).join(","),
        },
      );
      return { policy, result: "published", overridden: violations };
    });
  }

  /** Every published policy, oldest first. */
  listPolicyHistory(): Promise<StoredLanguagePolicy[]> {
    return this.guard("list_policy_history", () =>
      this.store.listPolicyHistory(),
    );
  }

  /** @throws LanguageLifecycleError INVALID_INPUT or STORE_UNAVAILABLE */
  getTenantSettings(tenantId: string): Promise<TenantLanguageSettings> {
    return this.guard("get_tenant_settings", async () => {
      requireIdentifier(tenantId, "tenantId");
      return this.tenantSettings(tenantId);
    });
  }

  /**
   * Replace the tenant's preview opt-ins. A language may be opted into before
   * it is listed as preview; the opt-in only has an effect while it is.
   *
   * @throws LanguageLifecycleError INVALID_INPUT or STORE_UNAVAILABLE
   */
  setPreviewOptIns(
    tenantId: string,
    languages: string[],
  ): Promise<TenantLanguageSettings> {
    return this.guard("set_preview_opt_ins", async () => {
      requireIdentifier(tenantId, "tenantId");
      if (!Array.isArray(languages)) {
        throw new LanguageLifecycleError(
          "INVALID_INPUT",
          "languages must be an array",
        );
      }
      languages.forEach(requireLanguage);
      const previewOptIns = [...new Set(languages)].sort(compareStrings);
      if (previewOptIns.length > this.config.maxLanguages) {
        throw new LanguageLifecycleError(
          "INVALID_INPUT",
          `at most ${this.config.maxLanguages} preview opt-ins are allowed`,
        );
      }
      const settings: TenantLanguageSettings = {
        tenantId,
        previewOptIns,
        updatedAt: this.clock(),
      };
      await this.store.putTenantSettings(settings);
      this.logger.log("info", "preview_opt_ins_updated", {
        tenantId,
        optInCount: previewOptIns.length,
      });
      return settings;
    });
  }

  /**
   * What the policy means for one tenant on `asOf` (default today), without
   * pinning anything. Safe to return to that tenant.
   */
  describeForTenant(
    tenantId: string,
    asOf?: string,
  ): Promise<TenantLanguageView> {
    return this.guard("describe_for_tenant", async () => {
      requireIdentifier(tenantId, "tenantId");
      const day = this.asOfOrToday(asOf);
      const policy = await this.currentPolicy();
      const settings = await this.tenantSettings(tenantId);
      return {
        policyVersion: policy.version,
        asOf: day,
        languages: evaluateDecisions(
          policy,
          day,
          settings.previewOptIns,
          this.config.enabled,
        ),
        previewOptIns: settings.previewOptIns,
      };
    });
  }

  /**
   * Pin (or re-read) the language decisions for one scan.
   *
   * @throws LanguageLifecycleError INVALID_INPUT or STORE_UNAVAILABLE
   *   (retryable; nothing is pinned)
   */
  resolveForScan(
    request: ScanLanguageRequest,
  ): Promise<ScanLanguageResolution> {
    return this.guard("resolve_for_scan", async () => {
      requireIdentifier(request?.tenantId, "tenantId");
      requireIdentifier(request.scanId, "scanId");
      const { tenantId, scanId } = request;
      const asOf = this.asOfOrToday(request.asOf);

      const existing = await this.store.getPin(tenantId, scanId);
      if (existing) {
        return this.reused(existing);
      }

      const policy = await this.currentPolicy();
      const settings = await this.tenantSettings(tenantId);
      const pin = buildPin({
        tenantId,
        scanId,
        policy,
        policyDigest: policy.digest,
        asOf,
        previewOptIns: settings.previewOptIns,
        enabled: this.config.enabled,
        unlistedAction: this.config.unlistedLanguageAction,
        pinnedAt: this.clock(),
      });
      if ((await this.store.createPin(pin)) === "exists") {
        // A concurrent attempt of the same scan pinned first; use its pin.
        const winner = await this.store.getPin(tenantId, scanId);
        if (winner) {
          return this.reused(winner);
        }
        throw new Error("pin vanished after a create conflict");
      }
      this.metrics.recordPin("created");
      this.logger.log("info", "scan_pinned", {
        tenantId,
        scanId,
        policyVersion: pin.policyVersion,
        asOf: pin.asOf,
        fingerprint: pin.fingerprint,
        enabled: this.config.enabled,
      });
      return { pin, status: "created" };
    });
  }

  /**
   * Classify a repository's files under `pin`. Pure apart from metrics and
   * logging: the same pin and language map always give the same plan.
   *
   * @throws LanguageLifecycleError INVALID_INPUT
   */
  planScan(
    pin: LanguageScanPin,
    languageMap: ReadonlyMap<string, string>,
  ): LanguageScanPlan {
    let plan: LanguageScanPlan;
    try {
      plan = planScan(pin, languageMap, this.config.maxFilesPerScan);
    } catch (error) {
      if (error instanceof LanguageLifecycleError) {
        this.metrics.recordError(error.code);
        this.logger.log("warn", "plan_scan_failed", {
          tenantId: pin?.tenantId,
          scanId: pin?.scanId,
          code: error.code,
        });
      }
      throw error;
    }
    this.metrics.recordPlan(plan);
    this.logger.log(
      plan.status === "complete" ? "info" : "warn",
      "scan_planned",
      {
        tenantId: pin.tenantId,
        scanId: pin.scanId,
        status: plan.status,
        analyzedCount: plan.analyze.size,
        skippedCount: plan.skipped.length,
        deprecatedLanguages: plan.warnings.map((w) => w.language).join(","),
        fingerprint: plan.fingerprint,
      },
    );
    return plan;
  }

  /**
   * Compare the current policy with the languages analyzers claim, e.g.
   * `AnalyzerRegistry.getSupportedLanguages()`.
   */
  checkCoverage(
    analyzerLanguages: readonly string[],
    asOf?: string,
  ): Promise<CoverageIssue[]> {
    return this.guard("check_coverage", async () =>
      checkPolicyCoverage(
        await this.currentPolicy(),
        analyzerLanguages,
        this.asOfOrToday(asOf),
      ),
    );
  }

  /** Remove pins older than `pinRetentionMs`; returns how many were removed. */
  purgeExpiredPins(): Promise<number> {
    return this.guard("purge_pins", async () => {
      const removed = await this.store.deletePinsBefore(
        this.clock() - this.config.pinRetentionMs,
      );
      this.logger.log("info", "pins_purged", { removed });
      return removed;
    });
  }

  private reused(pin: LanguageScanPin): ScanLanguageResolution {
    this.metrics.recordPin("reused");
    this.logger.log("info", "scan_pin_reused", {
      tenantId: pin.tenantId,
      scanId: pin.scanId,
      policyVersion: pin.policyVersion,
      fingerprint: pin.fingerprint,
    });
    return { pin, status: "reused" };
  }

  private async currentPolicy(): Promise<StoredLanguagePolicy> {
    return (await this.store.getPolicy()) ?? defaultStoredPolicy();
  }

  private async tenantSettings(
    tenantId: string,
  ): Promise<TenantLanguageSettings> {
    return (
      (await this.store.getTenantSettings(tenantId)) ?? {
        tenantId,
        previewOptIns: [],
        updatedAt: 0,
      }
    );
  }

  private asOfOrToday(asOf: string | undefined): string {
    if (asOf === undefined) {
      return utcDay(this.clock());
    }
    if (!isValidDay(asOf)) {
      throw new LanguageLifecycleError(
        "INVALID_INPUT",
        "asOf must be a YYYY-MM-DD date",
      );
    }
    return asOf;
  }

  private optionalReason(reason: unknown): string | undefined {
    if (reason === undefined) {
      return undefined;
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new LanguageLifecycleError(
        "INVALID_INPUT",
        "reason must be a non-empty string",
      );
    }
    return reason.trim().slice(0, MAX_REASON_LENGTH);
  }

  /**
   * Run `operation`, mapping unexpected (storage) errors to the retryable
   * STORE_UNAVAILABLE code. Store error messages are never logged or
   * returned, since they may contain paths or connection details.
   */
  private async guard<T>(
    operation: string,
    task: () => Promise<T>,
  ): Promise<T> {
    try {
      return await task();
    } catch (error) {
      const mapped =
        error instanceof LanguageLifecycleError
          ? error
          : new LanguageLifecycleError(
              "STORE_UNAVAILABLE",
              "the language lifecycle store is unavailable; retry later",
            );
      this.metrics.recordError(mapped.code);
      this.logger.log(mapped.retryable ? "error" : "warn", "operation_failed", {
        operation,
        code: mapped.code,
        retryable: mapped.retryable,
      });
      throw mapped;
    }
  }
}

function defaultStoredPolicy(): StoredLanguagePolicy {
  const policy = normalizePolicy(DEFAULT_LANGUAGE_POLICY, {
    maxLanguages: Number.MAX_SAFE_INTEGER,
    minDeprecationNoticeDays: 0,
  });
  return { ...policy, digest: policyDigest(policy), publishedAt: 0 };
}
