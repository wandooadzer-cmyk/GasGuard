/**
 * Worker-side adapter for the language lifecycle policy.
 *
 * `runScanWithLanguagePolicy` wraps one scan attempt: it resolves (or
 * re-reads) the scan's pinned language decisions, plans the repository's
 * files, and runs the scan over the files that may be analyzed. The scan
 * callback receives the filtered language map, which drops straight into
 * `AnalyzerRegistry.analyzeMultiple`.
 *
 * Failure semantics:
 * - STORE_UNAVAILABLE from resolution propagates before any analysis runs and
 *   is retryable, so the queue's normal retry policy applies.
 * - INVALID_INPUT and UNSUPPORTED_REPOSITORY are not retryable: the same
 *   commit and pin would fail the same way on every attempt.
 * - A `partial` plan runs; the skipped files and deprecation warnings travel
 *   with the result so reports can show them instead of implying a clean scan.
 */

import {
  LanguageLifecycleService,
  ScanLanguageResolution,
} from "./language-lifecycle.service";
import {
  LanguageLifecycleError,
  LanguageScanPlan,
} from "./language-lifecycle-types";

export interface LanguageScanAttempt {
  tenantId: string;
  scanId: string;
  /** Engine path → language map for the repository at the scanned commit. */
  languageMap: ReadonlyMap<string, string>;
  /** UTC day for scheduled dates, e.g. the commit date. Default: today. */
  asOf?: string;
}

export interface LanguageScopedResult<T> {
  result: T;
  plan: LanguageScanPlan;
  resolution: ScanLanguageResolution;
}

export async function runScanWithLanguagePolicy<T>(
  service: LanguageLifecycleService,
  attempt: LanguageScanAttempt,
  scan: (
    analyzableLanguageMap: Map<string, string>,
    plan: LanguageScanPlan,
  ) => Promise<T>,
): Promise<LanguageScopedResult<T>> {
  const resolution = await service.resolveForScan({
    tenantId: attempt.tenantId,
    scanId: attempt.scanId,
    asOf: attempt.asOf,
  });
  const plan = service.planScan(resolution.pin, attempt.languageMap);
  if (plan.status === "unsupported") {
    const languages = [...new Set(plan.skipped.map((f) => f.language))].join(
      ", ",
    );
    throw new LanguageLifecycleError(
      "UNSUPPORTED_REPOSITORY",
      `no file in this repository is in an analyzable language (found: ${languages})`,
    );
  }
  const result = await scan(new Map(plan.analyze), plan);
  return { result, plan, resolution };
}
