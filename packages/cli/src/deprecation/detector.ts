/**
 * Core deprecation detection and warning system.
 * 
 * Analyzes CLI arguments to detect deprecated flag usage and emit
 * structured warnings with actionable guidance.
 */

import { randomUUID } from "crypto";
import chalk from "chalk";
import {
  DeprecatedFlag,
  DeprecationAnalysisResult,
  DeprecationConfig,
  DeprecationMetrics,
  DeprecationSeverity,
  DeprecationUsage,
} from "./types";
import { createFlagLookup } from "./config";

/**
 * Analyzes CLI arguments for deprecated flag usage.
 */
export class DeprecationDetector {
  private readonly flagLookup: Map<string, DeprecatedFlag>;
  private readonly config: DeprecationConfig;
  private usages: DeprecationUsage[] = [];

  constructor(config: DeprecationConfig) {
    this.config = config;
    this.flagLookup = createFlagLookup(config.deprecatedFlags);
  }

  /**
   * Analyze an array of CLI arguments for deprecated flags.
   * 
   * @param argv - Command-line arguments to analyze
   * @param correlationId - Optional correlation ID for request tracing
   * @returns Analysis result with detected usages and metrics
   */
  public analyze(
    argv: string[],
    correlationId?: string
  ): DeprecationAnalysisResult {
    this.usages = [];
    const cid = correlationId || `dep_${randomUUID()}`;

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      
      // Skip non-flag arguments
      if (!arg.startsWith("-")) {
        continue;
      }

      // Handle --flag=value format
      const [flagPart, valuePart] = arg.split("=", 2);
      const deprecatedFlag = this.findDeprecatedFlag(flagPart);

      if (deprecatedFlag) {
        const usage: DeprecationUsage = {
          flag: deprecatedFlag,
          value: valuePart,
          position: i,
          timestamp: new Date(),
          correlationId: cid,
        };

        this.usages.push(usage);
      }
    }

    const metrics = this.calculateMetrics();
    const hasHighSeverity = this.usages.some(
      (u) => u.flag.severity === DeprecationSeverity.HIGH
    );

    return {
      usages: this.usages,
      hasHighSeverity,
      metrics,
    };
  }

  /**
   * Find a deprecated flag by its name (handles various formats).
   */
  private findDeprecatedFlag(flag: string): DeprecatedFlag | undefined {
    // Try exact match first
    if (this.flagLookup.has(flag)) {
      return this.flagLookup.get(flag);
    }

    // Try normalized format (with --)
    const normalized = flag.startsWith("--") ? flag : `--${flag}`;
    if (this.flagLookup.has(normalized)) {
      return this.flagLookup.get(normalized);
    }

    // Try without dashes
    const withoutDashes = flag.replace(/^-+/, "");
    return this.flagLookup.get(withoutDashes);
  }

  /**
   * Calculate aggregated metrics from detected usages.
   */
  private calculateMetrics(): DeprecationMetrics {
    const byFlag: Record<string, number> = {};
    const bySeverity: Record<DeprecationSeverity, number> = {
      [DeprecationSeverity.HIGH]: 0,
      [DeprecationSeverity.MEDIUM]: 0,
      [DeprecationSeverity.LOW]: 0,
    };

    let firstSeen: Date | undefined;
    let lastSeen: Date | undefined;

    for (const usage of this.usages) {
      // Count by flag
      byFlag[usage.flag.flag] = (byFlag[usage.flag.flag] || 0) + 1;

      // Count by severity
      bySeverity[usage.flag.severity]++;

      // Track timestamps
      if (!firstSeen || usage.timestamp < firstSeen) {
        firstSeen = usage.timestamp;
      }
      if (!lastSeen || usage.timestamp > lastSeen) {
        lastSeen = usage.timestamp;
      }
    }

    return {
      totalUsages: this.usages.length,
      byFlag,
      bySeverity,
      firstSeen,
      lastSeen,
    };
  }

  /**
   * Get all detected usages.
   */
  public getUsages(): DeprecationUsage[] {
    return [...this.usages];
  }

  /**
   * Clear all detected usages (useful for testing or reuse).
   */
  public clear(): void {
    this.usages = [];
  }
}

/**
 * Format a deprecation warning message for console output.
 */
export function formatDeprecationWarning(usage: DeprecationUsage): string {
  const { flag } = usage;
  const lines: string[] = [];

  // Header with severity indicator
  const severityColor = getSeverityColor(flag.severity);
  const severityLabel = flag.severity.toUpperCase();
  lines.push(
    chalk.yellow("\n⚠️  Deprecation Warning ") +
      severityColor(`[${severityLabel}]`)
  );

  // Main message
  lines.push(chalk.white(`   ${flag.message}`));

  // Replacement guidance
  if (flag.replacement) {
    lines.push(chalk.cyan(`   → Use: ${flag.replacement}`));
  }

  // Removal timeline
  if (flag.removedIn) {
    lines.push(
      chalk.red(`   ⏰ Will be removed in version ${flag.removedIn}`)
    );
  }

  // Documentation link
  if (flag.documentationUrl) {
    lines.push(chalk.dim(`   📖 ${flag.documentationUrl}`));
  }

  return lines.join("\n");
}

/**
 * Format multiple deprecation warnings as a summary.
 */
export function formatDeprecationSummary(
  result: DeprecationAnalysisResult
): string {
  if (result.usages.length === 0) {
    return "";
  }

  const lines: string[] = [];
  
  lines.push(
    chalk.yellow.bold(
      `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    )
  );
  lines.push(
    chalk.yellow.bold(`  DEPRECATION WARNINGS (${result.usages.length})`)
  );
  lines.push(
    chalk.yellow.bold(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    )
  );

  // Group by flag to avoid duplicate messages
  const uniqueFlags = new Map<string, DeprecationUsage>();
  for (const usage of result.usages) {
    if (!uniqueFlags.has(usage.flag.flag)) {
      uniqueFlags.set(usage.flag.flag, usage);
    }
  }

  // Display each unique deprecation
  for (const usage of uniqueFlags.values()) {
    lines.push(formatDeprecationWarning(usage));
  }

  // Summary statistics
  lines.push(
    chalk.yellow.bold(
      `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    )
  );
  lines.push(
    chalk.dim(
      `  Total: ${result.metrics.totalUsages} | ` +
        `High: ${result.metrics.bySeverity.high} | ` +
        `Medium: ${result.metrics.bySeverity.medium} | ` +
        `Low: ${result.metrics.bySeverity.low}`
    )
  );
  lines.push(
    chalk.yellow.bold(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    )
  );

  return lines.join("\n");
}

/**
 * Get chalk color function for a severity level.
 */
function getSeverityColor(
  severity: DeprecationSeverity
): (text: string) => string {
  switch (severity) {
    case DeprecationSeverity.HIGH:
      return chalk.red.bold;
    case DeprecationSeverity.MEDIUM:
      return chalk.yellow.bold;
    case DeprecationSeverity.LOW:
      return chalk.blue.bold;
    default:
      return chalk.white;
  }
}

/**
 * Emit deprecation warnings to stderr.
 */
export function emitDeprecationWarnings(
  result: DeprecationAnalysisResult,
  stream: NodeJS.WriteStream = process.stderr
): void {
  if (result.usages.length === 0) {
    return;
  }

  const summary = formatDeprecationSummary(result);
  stream.write(summary);
}

/**
 * Check if deprecation analysis should cause process failure.
 */
export function shouldFailOnDeprecation(
  result: DeprecationAnalysisResult,
  config: DeprecationConfig
): boolean {
  return config.failOnHighSeverity && result.hasHighSeverity;
}
