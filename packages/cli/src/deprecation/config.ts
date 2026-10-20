/**
 * Default deprecation configuration for GasGuard CLI flags.
 * 
 * This file defines which flags are deprecated, their replacements,
 * and when they will be removed.
 */

import { DeprecatedFlag, DeprecationConfig, DeprecationSeverity } from "./types";

/**
 * Registry of deprecated CLI flags.
 * 
 * Add new entries here when deprecating flags. Include clear migration
 * guidance and timeline information.
 */
export const DEPRECATED_FLAGS: DeprecatedFlag[] = [
  {
    flag: "--analyze-local",
    replacement: "scan",
    message: "The '--analyze-local' flag is deprecated. Use the 'scan' command instead.",
    severity: DeprecationSeverity.HIGH,
    deprecatedIn: "1.0.0",
    removedIn: "2.0.0",
    documentationUrl: "https://docs.gasguard.io/migration/analyze-local-to-scan",
  },
  {
    flag: "--no-progress",
    replacement: "--quiet",
    message: "The '--no-progress' flag is deprecated. Use '--quiet' for silent output.",
    severity: DeprecationSeverity.MEDIUM,
    deprecatedIn: "1.0.0",
    removedIn: "1.5.0",
    documentationUrl: "https://docs.gasguard.io/cli/output-options",
  },
  {
    flag: "--fix-preview",
    replacement: "config: output.fixPreview",
    message: "The '--fix-preview' flag is deprecated. Use 'output.fixPreview' in your config file instead.",
    severity: DeprecationSeverity.LOW,
    deprecatedIn: "1.0.0",
    documentationUrl: "https://docs.gasguard.io/config/output",
  },
];

/**
 * Default deprecation system configuration.
 */
export const DEFAULT_DEPRECATION_CONFIG: DeprecationConfig = {
  deprecatedFlags: DEPRECATED_FLAGS,
  enableWarnings: true,
  enableMetrics: true,
  failOnHighSeverity: false,
};

/**
 * Create a lookup map for fast flag resolution.
 */
export function createFlagLookup(
  flags: DeprecatedFlag[]
): Map<string, DeprecatedFlag> {
  const lookup = new Map<string, DeprecatedFlag>();
  
  for (const flag of flags) {
    // Support both --flag and -flag formats
    const normalized = flag.flag.startsWith("--") ? flag.flag : `--${flag.flag}`;
    lookup.set(normalized, flag);
    
    // Also store without dashes for flexible matching
    const withoutDashes = flag.flag.replace(/^-+/, "");
    lookup.set(withoutDashes, flag);
  }
  
  return lookup;
}

/**
 * Load deprecation configuration from environment or defaults.
 */
export function loadDeprecationConfig(): DeprecationConfig {
  const config = { ...DEFAULT_DEPRECATION_CONFIG };
  
  // Allow environment variable overrides
  if (process.env.GASGUARD_DEPRECATION_WARNINGS === "false") {
    config.enableWarnings = false;
  }
  
  if (process.env.GASGUARD_DEPRECATION_METRICS === "false") {
    config.enableMetrics = false;
  }
  
  if (process.env.GASGUARD_FAIL_ON_DEPRECATED === "true") {
    config.failOnHighSeverity = true;
  }
  
  return config;
}
