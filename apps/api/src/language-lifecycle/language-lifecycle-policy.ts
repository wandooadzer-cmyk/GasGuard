/**
 * Pure policy logic for the supported-language lifecycle: validation,
 * scheduled stage evaluation, governance checks between policy versions,
 * language detection, scan pins, and scan planning.
 *
 * Nothing here reads the clock, the environment, or storage. Every function is
 * a deterministic function of its arguments, which is what lets a scan's
 * decisions be pinned and reproduced exactly on retry or re-run.
 */

import * as crypto from "crypto";
import { Language } from "@engine/core/analyzer-interface";
import {
  LIFECYCLE_STAGES,
  LanguageDecision,
  LanguageLifecycleEntry,
  LanguageLifecycleError,
  LanguageLifecyclePolicy,
  LanguageScanPin,
  LanguageScanPlan,
  LanguageWarning,
  LifecycleStage,
  PolicyViolation,
  SkippedFile,
  UnlistedLanguageAction,
} from "./language-lifecycle-types";

const LANGUAGE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** `.sol`, or compound up to three segments such as `.d.ts`; length-capped below. */
const EXTENSION_PATTERN = /^(?:\.[a-z0-9][a-z0-9+_-]*){1,3}$/;
const MAX_EXTENSION_LENGTH = 16;
const VERSION_PATTERN =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_PATH_LENGTH = 4096;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Policy equivalent to the behaviour before lifecycle management: every
 * language the engine knows is `supported`. Used until an operator publishes.
 */
export const DEFAULT_LANGUAGE_POLICY: Readonly<LanguageLifecyclePolicy> =
  Object.freeze({
    version: "0.0.0",
    languages: [
      { language: Language.CAIRO, stage: "supported", extensions: [".cairo"] },
      {
        language: Language.JAVASCRIPT,
        stage: "supported",
        extensions: [".cjs", ".js", ".mjs"],
      },
      { language: Language.MOVE, stage: "supported", extensions: [".move"] },
      { language: Language.RUST, stage: "supported", extensions: [".rs"] },
      // Soroban contracts are Rust files; callers tell them apart.
      { language: Language.SOROBAN, stage: "supported", extensions: [] },
      { language: Language.SOLIDITY, stage: "supported", extensions: [".sol"] },
      {
        language: Language.TYPESCRIPT,
        stage: "supported",
        extensions: [".cts", ".mts", ".ts"],
      },
      { language: Language.VYPER, stage: "supported", extensions: [".vy"] },
    ] as LanguageLifecycleEntry[],
  });

export interface PolicyLimits {
  maxLanguages: number;
  minDeprecationNoticeDays: number;
}

/**
 * Validate `input` and return a canonical copy: unknown keys dropped,
 * languages sorted, extensions sorted. Two policies that mean the same thing
 * produce the same canonical form and therefore the same digest.
 *
 * @throws LanguageLifecycleError INVALID_POLICY listing every problem found
 */
export function normalizePolicy(
  input: unknown,
  limits: PolicyLimits,
): LanguageLifecyclePolicy {
  const errors: string[] = [];
  if (!isRecord(input)) {
    throw invalidPolicy(["policy must be an object"]);
  }
  if (
    typeof input.version !== "string" ||
    !VERSION_PATTERN.test(input.version)
  ) {
    errors.push("version must be MAJOR.MINOR.PATCH");
  }
  if (!Array.isArray(input.languages) || input.languages.length === 0) {
    throw invalidPolicy([...errors, "languages must be a non-empty array"]);
  }
  if (input.languages.length > limits.maxLanguages) {
    throw invalidPolicy([
      ...errors,
      `languages may list at most ${limits.maxLanguages} entries`,
    ]);
  }

  const entries: LanguageLifecycleEntry[] = [];
  const seenLanguages = new Set<string>();
  const extensionOwner = new Map<string, string>();

  input.languages.forEach((raw: unknown, index: number) => {
    const where = `languages[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const language = raw.language;
    if (typeof language !== "string" || !LANGUAGE_PATTERN.test(language)) {
      errors.push(`${where}.language must be a lower-case slug`);
      return;
    }
    const at = `language "${language}"`;
    if (seenLanguages.has(language)) {
      errors.push(`${at} is listed more than once`);
      return;
    }
    seenLanguages.add(language);

    const stage = raw.stage as LifecycleStage;
    if (!LIFECYCLE_STAGES.includes(stage)) {
      errors.push(`${at}: stage must be one of ${LIFECYCLE_STAGES.join(", ")}`);
      return;
    }

    const extensions: string[] = [];
    if (!Array.isArray(raw.extensions)) {
      errors.push(`${at}: extensions must be an array`);
    } else {
      for (const ext of raw.extensions) {
        if (
          typeof ext !== "string" ||
          ext.length > MAX_EXTENSION_LENGTH ||
          !EXTENSION_PATTERN.test(ext)
        ) {
          errors.push(`${at}: extension ${JSON.stringify(ext)} is invalid`);
          continue;
        }
        const owner = extensionOwner.get(ext);
        if (owner !== undefined && owner !== language) {
          errors.push(
            `${at}: extension "${ext}" is already claimed by "${owner}"`,
          );
          continue;
        }
        if (owner === undefined) {
          extensionOwner.set(ext, language);
          extensions.push(ext);
        }
      }
    }

    const entry: LanguageLifecycleEntry = {
      language,
      stage,
      extensions: extensions.sort(compareStrings),
    };
    for (const field of ["deprecatedAt", "sunsetAt"] as const) {
      const value = raw[field];
      if (value === undefined) {
        continue;
      }
      if (!isValidDay(value)) {
        errors.push(`${at}: ${field} must be a YYYY-MM-DD date`);
      } else {
        entry[field] = value;
      }
    }
    if (raw.replacement !== undefined) {
      if (
        typeof raw.replacement !== "string" ||
        !LANGUAGE_PATTERN.test(raw.replacement)
      ) {
        errors.push(`${at}: replacement must be a lower-case slug`);
      } else {
        entry.replacement = raw.replacement;
      }
    }

    errors.push(...checkEntryDates(entry, at, limits.minDeprecationNoticeDays));
    entries.push(entry);
  });

  const byLanguage = new Map(entries.map((e) => [e.language, e]));
  for (const entry of entries) {
    if (entry.replacement === undefined) {
      continue;
    }
    const target = byLanguage.get(entry.replacement);
    const at = `language "${entry.language}"`;
    if (entry.replacement === entry.language) {
      errors.push(`${at}: replacement cannot be the language itself`);
    } else if (!target) {
      errors.push(`${at}: replacement "${entry.replacement}" is not listed`);
    } else if (target.stage === "retired") {
      errors.push(`${at}: replacement "${entry.replacement}" is retired`);
    }
  }

  if (errors.length > 0) {
    throw invalidPolicy(errors);
  }
  return {
    version: input.version as string,
    languages: entries.sort((a, b) => compareStrings(a.language, b.language)),
  };
}

function checkEntryDates(
  entry: LanguageLifecycleEntry,
  at: string,
  minNoticeDays: number,
): string[] {
  const errors: string[] = [];
  const { stage, deprecatedAt, sunsetAt } = entry;
  if (stage === "preview" && (deprecatedAt || sunsetAt)) {
    errors.push(
      `${at}: preview languages carry no deprecation dates; retire them directly`,
    );
  }
  if (stage === "deprecated" && (!deprecatedAt || !sunsetAt)) {
    errors.push(`${at}: deprecated languages need deprecatedAt and sunsetAt`);
  }
  if (stage === "supported" && (deprecatedAt || sunsetAt)) {
    if (!deprecatedAt || !sunsetAt) {
      errors.push(
        `${at}: a scheduled deprecation needs both deprecatedAt and sunsetAt`,
      );
    }
  }
  if (stage !== "retired" && deprecatedAt && sunsetAt) {
    const noticeDays = dayDifference(deprecatedAt, sunsetAt);
    if (noticeDays < minNoticeDays) {
      errors.push(
        `${at}: sunsetAt must be at least ${minNoticeDays} days after deprecatedAt`,
      );
    }
  }
  return errors;
}

/** SHA-256 of the canonical policy (call on a `normalizePolicy` result). */
export function policyDigest(policy: LanguageLifecyclePolicy): string {
  return sha256(
    JSON.stringify({ version: policy.version, languages: policy.languages }),
  );
}

/** Stage of `entry` on day `asOf`, after applying its scheduled dates. */
export function effectiveStage(
  entry: LanguageLifecycleEntry,
  asOf: string,
): LifecycleStage {
  if (entry.stage === "retired" || entry.stage === "preview") {
    return entry.stage;
  }
  if (entry.sunsetAt !== undefined && asOf >= entry.sunsetAt) {
    return "retired";
  }
  if (entry.deprecatedAt !== undefined && asOf >= entry.deprecatedAt) {
    return "deprecated";
  }
  return entry.stage;
}

/** One decision per policy language, sorted by language. */
export function evaluateDecisions(
  policy: LanguageLifecyclePolicy,
  asOf: string,
  previewOptIns: readonly string[],
  enabled: boolean,
): LanguageDecision[] {
  const optedIn = new Set(previewOptIns);
  return [...policy.languages]
    .sort((a, b) => compareStrings(a.language, b.language))
    .map((entry) => {
      const stage = effectiveStage(entry, asOf);
      const decision: LanguageDecision = {
        language: entry.language,
        stage,
        ...decide(stage, enabled, optedIn.has(entry.language)),
      };
      if (stage === "deprecated" || stage === "retired") {
        if (entry.sunsetAt !== undefined) {
          decision.sunsetAt = entry.sunsetAt;
        }
        if (entry.replacement !== undefined) {
          decision.replacement = entry.replacement;
        }
      }
      return decision;
    });
}

function decide(
  stage: LifecycleStage,
  enabled: boolean,
  optedIn: boolean,
): Pick<LanguageDecision, "action" | "reason"> {
  if (!enabled) {
    return { action: "analyze", reason: "policy_disabled" };
  }
  switch (stage) {
    case "preview":
      return optedIn
        ? { action: "analyze", reason: "preview_opt_in" }
        : { action: "skip", reason: "preview_not_enabled" };
    case "supported":
      return { action: "analyze", reason: "supported" };
    case "deprecated":
      return { action: "analyze", reason: "deprecated" };
    case "retired":
      return { action: "skip", reason: "retired" };
  }
}

/**
 * Governance checks for replacing `previous` with `next` on day `asOf`.
 * Both must be canonical. An empty result means the change is safe for
 * tenants; anything else needs an explicit, reasoned override.
 */
export function checkPolicyTransition(
  previous: LanguageLifecyclePolicy,
  next: LanguageLifecyclePolicy,
  asOf: string,
  minNoticeDays: number,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  if (compareVersions(next.version, previous.version) <= 0) {
    violations.push({
      code: "VERSION_NOT_INCREASED",
      message: `version ${next.version} must be greater than ${previous.version}`,
    });
  }

  const nextByLanguage = new Map(next.languages.map((e) => [e.language, e]));
  for (const before of previous.languages) {
    const language = before.language;
    const after = nextByLanguage.get(language);
    if (!after) {
      violations.push({
        code: "LANGUAGE_REMOVED",
        language,
        message: `"${language}" was removed; retire it instead so its files are reported as skipped`,
      });
      continue;
    }
    const stageBefore = effectiveStage(before, asOf);
    const stageAfter = effectiveStage(after, asOf);
    if (stageBefore === "supported" && stageAfter === "retired") {
      violations.push({
        code: "SKIPPED_DEPRECATION",
        language,
        message: `"${language}" goes from supported to retired without a deprecation period`,
      });
      continue;
    }
    if (
      stageBefore !== "retired" &&
      after.sunsetAt !== undefined &&
      stageAfter !== "retired"
    ) {
      if (before.sunsetAt === undefined) {
        if (dayDifference(asOf, after.sunsetAt) < minNoticeDays) {
          violations.push({
            code: "INSUFFICIENT_NOTICE",
            language,
            message: `"${language}" sunsets on ${after.sunsetAt}, less than ${minNoticeDays} days from ${asOf}`,
          });
        }
      } else if (after.sunsetAt < before.sunsetAt) {
        violations.push({
          code: "SUNSET_PULLED_FORWARD",
          language,
          message: `"${language}" sunset moved from ${before.sunsetAt} to ${after.sunsetAt}`,
        });
      }
    }
  }
  return violations;
}

export type CoverageIssueKind = "no_analyzer" | "unlisted_analyzer_language";

export interface CoverageIssue {
  kind: CoverageIssueKind;
  language: string;
  message: string;
}

/**
 * Compare a policy with the languages analyzers actually claim (e.g.
 * `AnalyzerRegistry.getSupportedLanguages()` or a compatibility matrix).
 *
 * A language the policy promises to analyze with no analyzer would produce
 * zero findings that read as clean; an analyzed language the policy does not
 * list escapes lifecycle management. Retired languages need no analyzer.
 */
export function checkPolicyCoverage(
  policy: LanguageLifecyclePolicy,
  analyzerLanguages: readonly string[],
  asOf: string,
): CoverageIssue[] {
  const available = new Set(analyzerLanguages.map(String));
  const listed = new Set(policy.languages.map((e) => e.language));
  const issues: CoverageIssue[] = [];
  for (const entry of policy.languages) {
    if (effectiveStage(entry, asOf) === "retired") {
      continue;
    }
    if (!available.has(entry.language)) {
      issues.push({
        kind: "no_analyzer",
        language: entry.language,
        message: `"${entry.language}" is ${effectiveStage(entry, asOf)} but no analyzer supports it`,
      });
    }
  }
  for (const language of [...available].sort(compareStrings)) {
    if (!listed.has(language)) {
      issues.push({
        kind: "unlisted_analyzer_language",
        language,
        message: `an analyzer supports "${language}" but the policy does not list it`,
      });
    }
  }
  return issues;
}

/**
 * Map each path whose extension a policy entry claims to that language.
 * Matching is case-insensitive on the extension only; the longest claimed
 * extension wins, and paths with no claimed extension are left out.
 */
export function detectLanguages(
  paths: readonly string[],
  policy: LanguageLifecyclePolicy,
): Map<string, string> {
  const byExtension = new Map<string, string>();
  for (const entry of policy.languages) {
    for (const ext of entry.extensions) {
      byExtension.set(ext, entry.language);
    }
  }
  const result = new Map<string, string>();
  for (const filePath of [...paths].sort(compareStrings)) {
    requirePath(filePath);
    const base = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
    let match: string | undefined;
    let dot = base.indexOf(".", 1);
    while (dot !== -1 && match === undefined) {
      // Longest first: `a.test.ts` tries `.test.ts`, then `.ts`.
      match = byExtension.get(base.slice(dot));
      dot = base.indexOf(".", dot + 1);
    }
    if (match !== undefined) {
      result.set(filePath, match);
    }
  }
  return result;
}

export interface PinInput {
  tenantId: string;
  scanId: string;
  policy: LanguageLifecyclePolicy;
  policyDigest: string;
  asOf: string;
  previewOptIns: readonly string[];
  enabled: boolean;
  unlistedAction: UnlistedLanguageAction;
  pinnedAt: number;
}

export function buildPin(input: PinInput): LanguageScanPin {
  const decisions = evaluateDecisions(
    input.policy,
    input.asOf,
    input.previewOptIns,
    input.enabled,
  );
  // With the policy off, nothing is skipped, matching pre-policy behaviour.
  const unlistedAction: UnlistedLanguageAction = input.enabled
    ? input.unlistedAction
    : "analyze";
  const body = {
    policyVersion: input.policy.version,
    policyDigest: input.policyDigest,
    asOf: input.asOf,
    decisions,
    unlistedAction,
  };
  return {
    tenantId: input.tenantId,
    scanId: input.scanId,
    ...body,
    fingerprint: sha256(JSON.stringify(body)),
    pinnedAt: input.pinnedAt,
  };
}

/**
 * Split a repository's files into what will and will not be analyzed under
 * `pin`. `languageMap` is the engine's path → language map (see
 * `AnalyzerRegistry.analyzeMultiple`); files missing from it are not source
 * and are ignored, exactly as the registry ignores them.
 *
 * @throws LanguageLifecycleError INVALID_INPUT for malformed paths or
 *   languages, or more than `maxFiles` entries
 */
export function planScan(
  pin: LanguageScanPin,
  languageMap: ReadonlyMap<string, string>,
  maxFiles: number,
): LanguageScanPlan {
  if (!(languageMap instanceof Map)) {
    throw new LanguageLifecycleError(
      "INVALID_INPUT",
      "languageMap must be a Map of path to language",
    );
  }
  if (languageMap.size > maxFiles) {
    throw new LanguageLifecycleError(
      "INVALID_INPUT",
      `a scan may classify at most ${maxFiles} files`,
    );
  }
  const decisions = new Map(pin.decisions.map((d) => [d.language, d]));
  const analyze = new Map<string, string>();
  const skipped: SkippedFile[] = [];
  const deprecatedCounts = new Map<string, number>();

  for (const filePath of [...languageMap.keys()].sort(compareStrings)) {
    requirePath(filePath);
    const raw = languageMap.get(filePath);
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new LanguageLifecycleError(
        "INVALID_INPUT",
        "every language in languageMap must be a non-empty string",
      );
    }
    const language = raw.trim().toLowerCase();
    const decision = decisions.get(language);
    if (!decision) {
      if (pin.unlistedAction === "analyze") {
        analyze.set(filePath, language);
      } else {
        skipped.push({ path: filePath, language, reason: "unlisted_language" });
      }
      continue;
    }
    if (decision.action === "analyze") {
      analyze.set(filePath, language);
      if (decision.stage === "deprecated") {
        deprecatedCounts.set(
          language,
          (deprecatedCounts.get(language) ?? 0) + 1,
        );
      }
    } else {
      skipped.push({
        path: filePath,
        language,
        reason:
          decision.reason === "preview_not_enabled"
            ? "preview_not_enabled"
            : "retired",
      });
    }
  }

  const warnings: LanguageWarning[] = [...deprecatedCounts.keys()]
    .sort(compareStrings)
    .map((language) => {
      const decision = decisions.get(language)!;
      return deprecationWarning(decision, deprecatedCounts.get(language)!);
    });

  return {
    status:
      analyze.size === 0
        ? skipped.length === 0
          ? "empty"
          : "unsupported"
        : skipped.length === 0
          ? "complete"
          : "partial",
    analyze,
    skipped,
    warnings,
    fingerprint: pin.fingerprint,
  };
}

function deprecationWarning(
  decision: LanguageDecision,
  files: number,
): LanguageWarning {
  const sunset = decision.sunsetAt
    ? ` and will no longer be analyzed from ${decision.sunsetAt}`
    : "";
  const replacement = decision.replacement
    ? ` Migrate to "${decision.replacement}".`
    : "";
  const warning: LanguageWarning = {
    language: decision.language,
    files,
    message: `Language "${decision.language}" is deprecated${sunset}.${replacement}`,
  };
  if (decision.sunsetAt) {
    warning.sunsetAt = decision.sunsetAt;
  }
  if (decision.replacement) {
    warning.replacement = decision.replacement;
  }
  return warning;
}

/** UTC day (`YYYY-MM-DD`) of a millisecond timestamp. */
export function utcDay(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    throw new LanguageLifecycleError(
      "INVALID_INPUT",
      "timestamp must be finite",
    );
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function isValidDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && utcDayUnchecked(parsed) === value;
}

/** Negative when `a < b`; compares `MAJOR.MINOR.PATCH` numerically. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

/** Code-point order, independent of the host locale. */
export function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export function requireIdentifier(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new LanguageLifecycleError(
      "INVALID_INPUT",
      `${field} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} printable characters`,
    );
  }
}

export function requireLanguage(value: unknown): void {
  if (typeof value !== "string" || !LANGUAGE_PATTERN.test(value)) {
    throw new LanguageLifecycleError(
      "INVALID_INPUT",
      "language must be a lower-case slug",
    );
  }
}

function requirePath(value: unknown): void {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\u0000")
  ) {
    throw new LanguageLifecycleError(
      "INVALID_INPUT",
      `file paths must be non-empty strings of at most ${MAX_PATH_LENGTH} characters`,
    );
  }
}

function dayDifference(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

function utcDayUnchecked(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPolicy(errors: string[]): LanguageLifecycleError {
  return new LanguageLifecycleError(
    "INVALID_POLICY",
    `policy is invalid: ${errors.join("; ")}`,
    errors,
  );
}
