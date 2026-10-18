/**
 * Shared types for the supported-language lifecycle policy.
 *
 * Every language GasGuard can analyze moves through a documented lifecycle:
 *
 *   preview → supported → deprecated → retired
 *
 * `preview` languages run only for tenants that opted in. `supported` and
 * `deprecated` languages run for everyone, deprecated ones with a warning that
 * names the sunset date and any replacement. `retired` languages never run;
 * their files are reported as skipped, so a retired language can never look
 * like a clean result.
 *
 * The policy is platform-scoped operator data with a version. What a scan
 * actually uses is a `LanguageScanPin`, fixed the first time the scan resolves
 * its languages, so retries see the same decisions even if the policy, the
 * date, or the tenant's opt-ins change in between.
 */

export const LIFECYCLE_STAGES = [
  "preview",
  "supported",
  "deprecated",
  "retired",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** One language's entry in the policy. Dates are UTC days, `YYYY-MM-DD`. */
export interface LanguageLifecycleEntry {
  /** Lower-case slug matching the engine's language names, e.g. `solidity`. */
  language: string;
  /** Declared stage. Dates below can move it forward without a new policy. */
  stage: LifecycleStage;
  /**
   * File extensions (with the dot, lower-case) used by `detectLanguages`. May
   * be empty for languages that share an extension with another language and
   * are detected by the caller instead (e.g. `soroban` vs `rust`).
   */
  extensions: string[];
  /**
   * Day from which the language counts as deprecated. Required for
   * `deprecated`; on a `supported` entry it schedules the deprecation.
   */
  deprecatedAt?: string;
  /**
   * Day from which the language counts as retired. Required whenever
   * `deprecatedAt` is set, so every deprecation announces its end.
   */
  sunsetAt?: string;
  /** Language tenants should move to, when there is one. */
  replacement?: string;
}

/** Operator input to `publishPolicy`. */
export interface LanguageLifecyclePolicy {
  /** `MAJOR.MINOR.PATCH`; each publish must be strictly greater. */
  version: string;
  /** Sorted by `language` once validated. */
  languages: LanguageLifecycleEntry[];
}

/** A validated policy as persisted, with bookkeeping. */
export interface StoredLanguagePolicy extends LanguageLifecyclePolicy {
  /** SHA-256 of the canonical policy; part of every scan fingerprint. */
  digest: string;
  publishedAt: number;
  /** Operator reason, required when transition checks were overridden. */
  reason?: string;
  /** Transition violations that `force` overrode, for the audit trail. */
  overriddenViolations?: PolicyViolationCode[];
}

/** Tenant-scoped preferences. Never readable by another tenant. */
export interface TenantLanguageSettings {
  tenantId: string;
  /** Preview languages this tenant opted into. Sorted and unique. */
  previewOptIns: string[];
  updatedAt: number;
}

export type LanguageAction = "analyze" | "skip";

export type DecisionReason =
  | "supported"
  | "deprecated"
  | "preview_opt_in"
  | "preview_not_enabled"
  | "retired"
  /** The policy is switched off: every language runs as before the policy. */
  | "policy_disabled";

/** Effective treatment of one language for one scan. */
export interface LanguageDecision {
  language: string;
  /** Stage after applying scheduled dates at `asOf`. */
  stage: LifecycleStage;
  action: LanguageAction;
  reason: DecisionReason;
  sunsetAt?: string;
  replacement?: string;
}

/** What a scan does with languages the policy does not list. */
export type UnlistedLanguageAction = "analyze" | "skip";

/**
 * Language decisions fixed for one scan the first time it resolves, so
 * retries analyze the same languages.
 */
export interface LanguageScanPin {
  tenantId: string;
  scanId: string;
  /** Policy version and digest in force when the pin was created. */
  policyVersion: string;
  policyDigest: string;
  /** UTC day the scheduled dates were evaluated at. */
  asOf: string;
  /** One per policy language, sorted by `language`. */
  decisions: LanguageDecision[];
  unlistedAction: UnlistedLanguageAction;
  /** SHA-256 over everything above except ids; belongs in result cache keys. */
  fingerprint: string;
  pinnedAt: number;
}

export type SkipReason =
  | "retired"
  | "preview_not_enabled"
  | "unlisted_language";

export interface SkippedFile {
  path: string;
  language: string;
  reason: SkipReason;
}

export interface LanguageWarning {
  language: string;
  /** Number of files in the language that were analyzed anyway. */
  files: number;
  sunsetAt?: string;
  replacement?: string;
  message: string;
}

export type LanguagePlanStatus =
  /** Every source file will be analyzed. */
  | "complete"
  /** Some source files were skipped; the rest will be analyzed. */
  | "partial"
  /** Source files exist but none can be analyzed. */
  | "unsupported"
  /** No file had a recognised language. */
  | "empty";

/** Result of applying a pin to a repository's files. Deterministic. */
export interface LanguageScanPlan {
  status: LanguagePlanStatus;
  /** Path to language for files that will be analyzed, in path order. */
  analyze: Map<string, string>;
  /** Sorted by path. */
  skipped: SkippedFile[];
  /** One per deprecated language present, sorted by language. */
  warnings: LanguageWarning[];
  fingerprint: string;
}

export type PolicyViolationCode =
  | "VERSION_NOT_INCREASED"
  | "LANGUAGE_REMOVED"
  | "SKIPPED_DEPRECATION"
  | "INSUFFICIENT_NOTICE"
  | "SUNSET_PULLED_FORWARD";

export interface PolicyViolation {
  code: PolicyViolationCode;
  language?: string;
  message: string;
}

export type LanguageLifecycleErrorCode =
  | "INVALID_INPUT"
  | "INVALID_POLICY"
  | "TRANSITION_REJECTED"
  | "UNSUPPORTED_REPOSITORY"
  | "CONFLICT"
  | "STORE_UNAVAILABLE";

const RETRYABLE_CODES: ReadonlySet<LanguageLifecycleErrorCode> = new Set([
  "CONFLICT",
  "STORE_UNAVAILABLE",
]);

export class LanguageLifecycleError extends Error {
  readonly code: LanguageLifecycleErrorCode;
  /** True when the same call may succeed if retried unchanged. */
  readonly retryable: boolean;
  /** Present on INVALID_POLICY and TRANSITION_REJECTED. */
  readonly violations: readonly (PolicyViolation | string)[];

  constructor(
    code: LanguageLifecycleErrorCode,
    message: string,
    violations: readonly (PolicyViolation | string)[] = [],
  ) {
    super(message);
    this.name = "LanguageLifecycleError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.violations = violations;
  }
}
