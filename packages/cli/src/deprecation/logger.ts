/**
 * Structured logging for deprecation events.
 * 
 * Provides operational visibility into deprecation usage patterns
 * while excluding sensitive information.
 */

import { DeprecationAnalysisResult, DeprecationUsage } from "./types";

/**
 * Log entry for deprecation events.
 */
export interface DeprecationLogEntry {
  timestamp: string;
  level: "warn" | "info" | "error";
  event: string;
  correlationId: string;
  message: string;
  flag?: string;
  severity?: string;
  replacement?: string;
  position?: number;
  totalUsages?: number;
  highSeverityCount?: number;
}

/**
 * Logger for deprecation events that writes structured JSON to stderr.
 */
export class DeprecationLogger {
  private readonly stream: NodeJS.WriteStream;

  constructor(stream: NodeJS.WriteStream = process.stderr) {
    this.stream = stream;
  }

  /**
   * Log a single deprecated flag usage.
   */
  public logUsage(usage: DeprecationUsage): void {
    const entry: DeprecationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "cli.deprecation.detected",
      correlationId: usage.correlationId,
      message: `Deprecated flag detected: ${usage.flag.flag}`,
      flag: usage.flag.flag,
      severity: usage.flag.severity,
      replacement: usage.flag.replacement,
      position: usage.position,
    };

    this.writeLogLine(entry);
  }

  /**
   * Log a deprecation analysis summary.
   */
  public logAnalysis(result: DeprecationAnalysisResult): void {
    if (result.usages.length === 0) {
      return;
    }

    const entry: DeprecationLogEntry = {
      timestamp: new Date().toISOString(),
      level: result.hasHighSeverity ? "error" : "warn",
      event: "cli.deprecation.analysis",
      correlationId:
        result.usages[0]?.correlationId || `dep_${Date.now()}`,
      message: `Deprecation analysis completed: ${result.metrics.totalUsages} usage(s) detected`,
      totalUsages: result.metrics.totalUsages,
      highSeverityCount: result.metrics.bySeverity.high,
    };

    this.writeLogLine(entry);
  }

  /**
   * Log start of deprecation check.
   */
  public logStart(correlationId: string): void {
    const entry: DeprecationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      event: "cli.deprecation.check.start",
      correlationId,
      message: "Starting deprecation check",
    };

    this.writeLogLine(entry);
  }

  /**
   * Log completion of deprecation check.
   */
  public logComplete(
    correlationId: string,
    usageCount: number,
    durationMs: number
  ): void {
    const entry: DeprecationLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      event: "cli.deprecation.check.complete",
      correlationId,
      message: `Deprecation check completed in ${durationMs}ms`,
      totalUsages: usageCount,
    };

    this.writeLogLine(entry);
  }

  /**
   * Write a structured log line to stderr.
   */
  private writeLogLine(entry: DeprecationLogEntry): void {
    try {
      const line = JSON.stringify({
        component: "cli.deprecation",
        ...entry,
      });
      this.stream.write(`${line}\n`);
    } catch (error) {
      // Fail silently to avoid disrupting the CLI
      // In production, this should never happen with well-formed objects
    }
  }
}

/**
 * Global singleton logger instance.
 */
let globalLogger: DeprecationLogger | undefined;

/**
 * Get or create the global deprecation logger.
 */
export function getDeprecationLogger(): DeprecationLogger {
  if (!globalLogger) {
    globalLogger = new DeprecationLogger();
  }
  return globalLogger;
}

/**
 * Set a custom global logger (useful for testing).
 */
export function setDeprecationLogger(logger: DeprecationLogger): void {
  globalLogger = logger;
}

/**
 * Reset the global logger (useful for testing).
 */
export function resetDeprecationLogger(): void {
  globalLogger = undefined;
}
