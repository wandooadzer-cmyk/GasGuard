/**
 * Deprecation warning system for GasGuard CLI flags.
 * 
 * This module provides detection, warning, and tracking capabilities
 * for deprecated CLI flags across the analyzer platform.
 * 
 * @module deprecation
 */

export * from "./types";
export * from "./config";
export * from "./detector";
export * from "./logger";
export * from "./metrics";
export * from "./integration";

import { randomUUID } from "crypto";
import { loadDeprecationConfig } from "./config";
import {
  DeprecationDetector,
  emitDeprecationWarnings,
  shouldFailOnDeprecation,
} from "./detector";
import { getDeprecationLogger } from "./logger";
import { getMetricsCollector } from "./metrics";
import { DeprecationAnalysisResult } from "./types";

/**
 * Main entry point for deprecation checking in CLI commands.
 * 
 * Analyzes argv for deprecated flags, emits warnings, tracks metrics,
 * and optionally fails the process on high-severity deprecations.
 * 
 * @param argv - Command-line arguments to check
 * @param correlationId - Optional correlation ID for request tracing
 * @returns Analysis result with detected usages
 * 
 * @example
 * ```typescript
 * import { checkDeprecatedFlags } from './deprecation';
 * 
 * const result = checkDeprecatedFlags(process.argv);
 * if (result.hasHighSeverity) {
 *   console.error('High-severity deprecated flags detected!');
 * }
 * ```
 */
export function checkDeprecatedFlags(
  argv: string[],
  correlationId?: string
): DeprecationAnalysisResult {
  const config = loadDeprecationConfig();
  const cid = correlationId || `dep_${randomUUID()}`;
  const logger = getDeprecationLogger();
  const metricsCollector = getMetricsCollector();

  const startTime = Date.now();

  // Log start of check
  if (config.enableWarnings) {
    logger.logStart(cid);
  }

  // Perform analysis
  const detector = new DeprecationDetector(config);
  const result = detector.analyze(argv, cid);

  // Emit warnings if enabled
  if (config.enableWarnings && result.usages.length > 0) {
    emitDeprecationWarnings(result);
    logger.logAnalysis(result);
  }

  // Track metrics if enabled
  if (config.enableMetrics) {
    metricsCollector.record(result);
  }

  // Log completion
  const durationMs = Date.now() - startTime;
  if (config.enableWarnings) {
    logger.logComplete(cid, result.usages.length, durationMs);
  }

  // Handle failure on high severity
  if (shouldFailOnDeprecation(result, config)) {
    process.stderr.write(
      "\n❌ Exiting due to high-severity deprecated flags. " +
        "Set GASGUARD_FAIL_ON_DEPRECATED=false to continue.\n\n"
    );
    process.exit(1);
  }

  return result;
}
