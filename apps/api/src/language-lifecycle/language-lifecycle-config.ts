/**
 * Configuration surface for the supported-language lifecycle policy.
 *
 * Defaults reproduce today's behaviour (every language with an analyzer runs)
 * until an operator publishes a policy. Values are validated once at
 * construction; an invalid value fails fast with a `RangeError` naming the
 * offending option rather than silently falling back.
 */

import { UnlistedLanguageAction } from "./language-lifecycle-types";

export interface LanguageLifecycleConfig {
  /**
   * Master switch and kill switch. When false, new scans analyze every
   * language (reason `policy_disabled`). Existing scan pins are still honoured
   * so in-flight retries stay deterministic.
   */
  enabled: boolean;
  /** Shortest allowed gap between `deprecatedAt` and `sunsetAt`, in days. */
  minDeprecationNoticeDays: number;
  /**
   * What happens to files in a language the policy does not list. `analyze`
   * keeps the pre-policy behaviour; `skip` reports them as skipped.
   */
  unlistedLanguageAction: UnlistedLanguageAction;
  /** Largest number of files one scan plan may classify. */
  maxFilesPerScan: number;
  /** Largest number of languages a policy may list. */
  maxLanguages: number;
  /** How long scan pins are kept before `purgeExpiredPins` removes them. */
  pinRetentionMs: number;
}

export const DEFAULT_LANGUAGE_LIFECYCLE_CONFIG: Readonly<LanguageLifecycleConfig> =
  Object.freeze({
    enabled: true,
    minDeprecationNoticeDays: 90,
    unlistedLanguageAction: "analyze",
    maxFilesPerScan: 100_000,
    maxLanguages: 64,
    pinRetentionMs: 7 * 24 * 60 * 60 * 1000,
  });

const ENV_KEYS: Record<keyof LanguageLifecycleConfig, string> = {
  enabled: "LANGUAGE_LIFECYCLE_ENABLED",
  minDeprecationNoticeDays: "LANGUAGE_LIFECYCLE_MIN_NOTICE_DAYS",
  unlistedLanguageAction: "LANGUAGE_LIFECYCLE_UNLISTED_ACTION",
  maxFilesPerScan: "LANGUAGE_LIFECYCLE_MAX_FILES",
  maxLanguages: "LANGUAGE_LIFECYCLE_MAX_LANGUAGES",
  pinRetentionMs: "LANGUAGE_LIFECYCLE_PIN_RETENTION_MS",
};

const UNLISTED_ACTIONS: readonly UnlistedLanguageAction[] = ["analyze", "skip"];

/** Merge `overrides` over the defaults and validate the result. */
export function resolveLanguageLifecycleConfig(
  overrides: Partial<LanguageLifecycleConfig> = {},
): LanguageLifecycleConfig {
  const config: LanguageLifecycleConfig = {
    ...DEFAULT_LANGUAGE_LIFECYCLE_CONFIG,
    ...stripUndefined(overrides),
  };

  if (typeof config.enabled !== "boolean") {
    throw new RangeError("enabled must be a boolean");
  }
  requireNonNegativeInteger(
    config.minDeprecationNoticeDays,
    "minDeprecationNoticeDays",
  );
  if (!UNLISTED_ACTIONS.includes(config.unlistedLanguageAction)) {
    throw new RangeError(
      `unlistedLanguageAction must be one of ${UNLISTED_ACTIONS.join(", ")}`,
    );
  }
  requirePositiveInteger(config.maxFilesPerScan, "maxFilesPerScan");
  requirePositiveInteger(config.maxLanguages, "maxLanguages");
  requirePositiveInteger(config.pinRetentionMs, "pinRetentionMs");
  return config;
}

/**
 * Build a config from `LANGUAGE_LIFECYCLE_*` environment variables.
 *
 * Unset or empty variables keep their defaults; set-but-unparseable values
 * throw so a typo in deployment config is caught at startup.
 */
export function loadLanguageLifecycleConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): LanguageLifecycleConfig {
  const overrides: Record<string, unknown> = {};
  for (const [field, envKey] of Object.entries(ENV_KEYS) as [
    keyof LanguageLifecycleConfig,
    string,
  ][]) {
    const raw = env[envKey];
    if (raw === undefined || raw.trim() === "") {
      continue;
    }
    const value = raw.trim();
    if (field === "enabled") {
      overrides[field] = parseBoolean(value, envKey);
    } else if (field === "unlistedLanguageAction") {
      const lowered = value.toLowerCase();
      if (!UNLISTED_ACTIONS.includes(lowered as UnlistedLanguageAction)) {
        throw new RangeError(
          `${envKey} must be one of ${UNLISTED_ACTIONS.join(", ")}`,
        );
      }
      overrides[field] = lowered;
    } else {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new RangeError(`${envKey} must be a number`);
      }
      overrides[field] = parsed;
    }
  }
  return resolveLanguageLifecycleConfig(
    overrides as Partial<LanguageLifecycleConfig>,
  );
}

function parseBoolean(value: string, envKey: string): boolean {
  const lowered = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lowered)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(lowered)) {
    return false;
  }
  throw new RangeError(`${envKey} must be a boolean`);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}
