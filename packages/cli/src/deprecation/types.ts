/**
 * Types for CLI flag deprecation system.
 * 
 * This module defines the core types for tracking and warning about deprecated
 * CLI flags across the GasGuard analyzer platform.
 */

/**
 * Severity level for deprecation warnings.
 */
export enum DeprecationSeverity {
  /** Flag will be removed in the next major version */
  HIGH = "high",
  /** Flag will be removed in a future version */
  MEDIUM = "medium",
  /** Flag is soft-deprecated but no removal planned yet */
  LOW = "low",
}

/**
 * Metadata about a deprecated CLI flag.
 */
export interface DeprecatedFlag {
  /** The deprecated flag name (e.g., "--no-summary") */
  flag: string;
  /** Replacement flag or configuration option */
  replacement?: string;
  /** Human-readable deprecation message */
  message: string;
  /** Severity of the deprecation */
  severity: DeprecationSeverity;
  /** Version when the flag was deprecated */
  deprecatedIn: string;
  /** Version when the flag will be removed (if known) */
  removedIn?: string;
  /** Link to migration guide or documentation */
  documentationUrl?: string;
}

/**
 * Configuration for the deprecation warning system.
 */
export interface DeprecationConfig {
  /** List of deprecated flags */
  deprecatedFlags: DeprecatedFlag[];
  /** Whether to emit warnings to stderr */
  enableWarnings: boolean;
  /** Whether to track deprecation usage metrics */
  enableMetrics: boolean;
  /** Whether to fail on high-severity deprecations */
  failOnHighSeverity: boolean;
}

/**
 * A detected usage of a deprecated flag.
 */
export interface DeprecationUsage {
  /** The deprecated flag that was used */
  flag: DeprecatedFlag;
  /** The actual argument value provided (if any) */
  value?: string;
  /** Position in argv where the flag was found */
  position: number;
  /** Timestamp of detection */
  timestamp: Date;
  /** Correlation ID for request tracing */
  correlationId: string;
}

/**
 * Aggregated metrics for deprecation tracking.
 */
export interface DeprecationMetrics {
  /** Total number of deprecated flags detected */
  totalUsages: number;
  /** Usages grouped by flag name */
  byFlag: Record<string, number>;
  /** Usages grouped by severity */
  bySeverity: Record<DeprecationSeverity, number>;
  /** First detection timestamp */
  firstSeen?: Date;
  /** Last detection timestamp */
  lastSeen?: Date;
}

/**
 * Result of deprecation analysis on CLI arguments.
 */
export interface DeprecationAnalysisResult {
  /** List of detected deprecated flag usages */
  usages: DeprecationUsage[];
  /** Whether any high-severity deprecations were found */
  hasHighSeverity: boolean;
  /** Aggregated metrics */
  metrics: DeprecationMetrics;
}
