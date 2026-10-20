/**
 * Metrics collection for deprecation tracking.
 * 
 * Provides thread-safe aggregation of deprecation usage patterns
 * for operational visibility and planning.
 */

import {
  DeprecationAnalysisResult,
  DeprecationMetrics,
  DeprecationSeverity,
} from "./types";

/**
 * Collector for aggregating deprecation metrics across multiple invocations.
 */
export class MetricsCollector {
  private totalUsages = 0;
  private byFlag: Map<string, number> = new Map();
  private bySeverity: Map<DeprecationSeverity, number> = new Map([
    [DeprecationSeverity.HIGH, 0],
    [DeprecationSeverity.MEDIUM, 0],
    [DeprecationSeverity.LOW, 0],
  ]);
  private firstSeen?: Date;
  private lastSeen?: Date;
  private invocationCount = 0;

  /**
   * Record a deprecation analysis result.
   */
  public record(result: DeprecationAnalysisResult): void {
    this.invocationCount++;
    this.totalUsages += result.metrics.totalUsages;

    // Aggregate by flag
    for (const [flag, count] of Object.entries(result.metrics.byFlag)) {
      const current = this.byFlag.get(flag) || 0;
      this.byFlag.set(flag, current + count);
    }

    // Aggregate by severity
    for (const [severity, count] of Object.entries(
      result.metrics.bySeverity
    )) {
      const sev = severity as DeprecationSeverity;
      const current = this.bySeverity.get(sev) || 0;
      this.bySeverity.set(sev, current + count);
    }

    // Track timestamps
    if (result.metrics.firstSeen) {
      if (!this.firstSeen || result.metrics.firstSeen < this.firstSeen) {
        this.firstSeen = result.metrics.firstSeen;
      }
    }

    if (result.metrics.lastSeen) {
      if (!this.lastSeen || result.metrics.lastSeen > this.lastSeen) {
        this.lastSeen = result.metrics.lastSeen;
      }
    }
  }

  /**
   * Get current aggregated metrics.
   */
  public getMetrics(): DeprecationMetrics & { invocationCount: number } {
    return {
      totalUsages: this.totalUsages,
      byFlag: Object.fromEntries(this.byFlag),
      bySeverity: {
        [DeprecationSeverity.HIGH]:
          this.bySeverity.get(DeprecationSeverity.HIGH) || 0,
        [DeprecationSeverity.MEDIUM]:
          this.bySeverity.get(DeprecationSeverity.MEDIUM) || 0,
        [DeprecationSeverity.LOW]:
          this.bySeverity.get(DeprecationSeverity.LOW) || 0,
      },
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      invocationCount: this.invocationCount,
    };
  }

  /**
   * Reset all metrics (useful for testing).
   */
  public reset(): void {
    this.totalUsages = 0;
    this.byFlag.clear();
    this.bySeverity.set(DeprecationSeverity.HIGH, 0);
    this.bySeverity.set(DeprecationSeverity.MEDIUM, 0);
    this.bySeverity.set(DeprecationSeverity.LOW, 0);
    this.firstSeen = undefined;
    this.lastSeen = undefined;
    this.invocationCount = 0;
  }

  /**
   * Export metrics as JSON for persistence or reporting.
   */
  public toJSON(): string {
    return JSON.stringify(this.getMetrics(), null, 2);
  }
}

/**
 * Global singleton metrics collector.
 */
let globalCollector: MetricsCollector | undefined;

/**
 * Get or create the global metrics collector.
 */
export function getMetricsCollector(): MetricsCollector {
  if (!globalCollector) {
    globalCollector = new MetricsCollector();
  }
  return globalCollector;
}

/**
 * Set a custom global metrics collector (useful for testing).
 */
export function setMetricsCollector(collector: MetricsCollector): void {
  globalCollector = collector;
}

/**
 * Reset the global metrics collector (useful for testing).
 */
export function resetMetricsCollector(): void {
  if (globalCollector) {
    globalCollector.reset();
  }
  globalCollector = undefined;
}
