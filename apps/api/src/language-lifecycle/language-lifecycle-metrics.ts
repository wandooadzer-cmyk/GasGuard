/**
 * Metrics and structured logging for the language lifecycle policy.
 *
 * Labels are drawn from closed sets (stages, actions, reasons, plan statuses,
 * violation and error codes) plus the language, which is a validated slug from
 * the operator-controlled policy. Tenant, repository, scan ids and file paths
 * never become labels, so cardinality stays bounded and no customer
 * identifiers reach a metrics backend.
 *
 * Log fields pass through `sanitizeLogFields`, which keeps only primitive
 * values, truncates long strings, and drops keys that look like they carry
 * payloads or credentials. The service logs identifiers, versions, counts and
 * codes only; it never logs file paths, source, or store error messages.
 */

import {
  LanguagePlanStatus,
  LanguageScanPlan,
  SkipReason,
  StoredLanguagePolicy,
} from "./language-lifecycle-types";
import { effectiveStage } from "./language-lifecycle-policy";

export interface LanguageLifecycleMetricsSnapshot {
  pinsCreated: number;
  pinsReused: number;
  /** Keyed by plan status. */
  plans: Record<string, number>;
  /** Keyed by `${language}:${reason}`. */
  filesSkipped: Record<string, number>;
  /** Files analyzed in a deprecated language, keyed by language. */
  deprecatedFiles: Record<string, number>;
  /** Keyed by `published`, `unchanged`, or `forced`. */
  policyPublishes: Record<string, number>;
  /** Transition violations seen at publish time, keyed by code. */
  violations: Record<string, number>;
  errors: Record<string, number>;
}

export class LanguageLifecycleMetrics {
  private readonly plans: Map<string, number> = new Map();
  private readonly filesSkipped: Map<string, number> = new Map();
  private readonly deprecatedFiles: Map<string, number> = new Map();
  private readonly policyPublishes: Map<string, number> = new Map();
  private readonly violations: Map<string, number> = new Map();
  private readonly errors: Map<string, number> = new Map();
  private pinsCreated = 0;
  private pinsReused = 0;

  recordPin(result: "created" | "reused"): void {
    if (result === "created") {
      this.pinsCreated++;
    } else {
      this.pinsReused++;
    }
  }

  recordPlan(plan: LanguageScanPlan): void {
    increment(this.plans, plan.status);
    for (const file of plan.skipped) {
      increment(this.filesSkipped, `${file.language}:${file.reason}`);
    }
    for (const warning of plan.warnings) {
      increment(this.deprecatedFiles, warning.language, warning.files);
    }
  }

  recordPublish(kind: "published" | "unchanged" | "forced"): void {
    increment(this.policyPublishes, kind);
  }

  recordViolation(code: string): void {
    increment(this.violations, code);
  }

  recordError(code: string): void {
    increment(this.errors, code);
  }

  snapshot(): LanguageLifecycleMetricsSnapshot {
    return {
      pinsCreated: this.pinsCreated,
      pinsReused: this.pinsReused,
      plans: Object.fromEntries(this.plans),
      filesSkipped: Object.fromEntries(this.filesSkipped),
      deprecatedFiles: Object.fromEntries(this.deprecatedFiles),
      policyPublishes: Object.fromEntries(this.policyPublishes),
      violations: Object.fromEntries(this.violations),
      errors: Object.fromEntries(this.errors),
    };
  }

  /**
   * Prometheus text exposition of the counters, plus a per-language stage
   * gauge when `policy` and `asOf` are given.
   */
  toPrometheus(policy?: StoredLanguagePolicy, asOf?: string): string {
    const lines: string[] = [];
    const header = (name: string, type: string, help: string) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };

    header(
      "gasguard_language_pins_total",
      "counter",
      "Scan language pins by whether they were created or reused (retries).",
    );
    lines.push(
      `gasguard_language_pins_total{result="created"} ${this.pinsCreated}`,
    );
    lines.push(
      `gasguard_language_pins_total{result="reused"} ${this.pinsReused}`,
    );
    header(
      "gasguard_language_plans_total",
      "counter",
      "Scan plans by status (complete, partial, unsupported, empty).",
    );
    for (const [status, value] of this.plans) {
      lines.push(`gasguard_language_plans_total{status="${status}"} ${value}`);
    }
    header(
      "gasguard_language_files_skipped_total",
      "counter",
      "Files not analyzed because of the language lifecycle, by language and reason.",
    );
    for (const [key, value] of this.filesSkipped) {
      const [language, reason] = key.split(":");
      lines.push(
        `gasguard_language_files_skipped_total{language="${language}",reason="${reason}"} ${value}`,
      );
    }
    header(
      "gasguard_language_deprecated_files_total",
      "counter",
      "Files analyzed in a deprecated language, by language.",
    );
    for (const [language, value] of this.deprecatedFiles) {
      lines.push(
        `gasguard_language_deprecated_files_total{language="${language}"} ${value}`,
      );
    }
    header(
      "gasguard_language_policy_publishes_total",
      "counter",
      "Policy publish calls by result.",
    );
    for (const [kind, value] of this.policyPublishes) {
      lines.push(
        `gasguard_language_policy_publishes_total{result="${kind}"} ${value}`,
      );
    }
    header(
      "gasguard_language_policy_violations_total",
      "counter",
      "Transition violations found when publishing a policy, by code.",
    );
    for (const [code, value] of this.violations) {
      lines.push(
        `gasguard_language_policy_violations_total{code="${code}"} ${value}`,
      );
    }
    header(
      "gasguard_language_lifecycle_errors_total",
      "counter",
      "Language lifecycle operations that failed, by error code.",
    );
    for (const [code, value] of this.errors) {
      lines.push(
        `gasguard_language_lifecycle_errors_total{code="${code}"} ${value}`,
      );
    }

    if (policy && asOf) {
      header(
        "gasguard_language_stage",
        "gauge",
        "1 for each language's effective lifecycle stage in the current policy.",
      );
      for (const entry of policy.languages) {
        lines.push(
          `gasguard_language_stage{language="${entry.language}",stage="${effectiveStage(entry, asOf)}"} 1`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

/** Closed label sets, exported for tests and dashboards. */
export const PLAN_STATUSES: readonly LanguagePlanStatus[] = [
  "complete",
  "partial",
  "unsupported",
  "empty",
];
export const SKIP_REASONS: readonly SkipReason[] = [
  "retired",
  "preview_not_enabled",
  "unlisted_language",
];

export type LanguageLifecycleLogLevel = "info" | "warn" | "error";
export type LanguageLifecycleLogFields = Record<
  string,
  string | number | boolean | undefined
>;

export interface LanguageLifecycleLogger {
  log(
    level: LanguageLifecycleLogLevel,
    event: string,
    fields: LanguageLifecycleLogFields,
  ): void;
}

/** Emits one JSON object per line on stdout/stderr. */
export const consoleLanguageLifecycleLogger: LanguageLifecycleLogger = {
  log(level, event, fields) {
    const line = JSON.stringify({
      level,
      component: "language-lifecycle",
      event,
      ...sanitizeLogFields(fields),
    });
    if (level === "info") {
      console.log(line);
    } else {
      console.error(line);
    }
  },
};

const MAX_LOG_STRING = 200;
/** Keys that must never reach a log line, even if a caller passes them. */
const FORBIDDEN_LOG_KEY =
  /payload|document|content|source|body|path|file|secret|token|password|key|credential|authorization/i;

export function sanitizeLogFields(
  fields: Record<string, unknown>,
): LanguageLifecycleLogFields {
  const safe: LanguageLifecycleLogFields = {};
  for (const [field, value] of Object.entries(fields)) {
    if (FORBIDDEN_LOG_KEY.test(field)) {
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      safe[field] = value;
    } else if (typeof value === "string") {
      safe[field] =
        value.length > MAX_LOG_STRING
          ? `${value.slice(0, MAX_LOG_STRING)}…`
          : value;
    }
  }
  return safe;
}

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}
