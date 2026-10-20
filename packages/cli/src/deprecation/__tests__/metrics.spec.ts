/**
 * Unit tests for deprecation metrics collector.
 */

import {
  MetricsCollector,
  getMetricsCollector,
  resetMetricsCollector,
  setMetricsCollector,
} from "../metrics";
import { DeprecationAnalysisResult, DeprecationSeverity } from "../types";

const mockAnalysisResult = (
  totalUsages: number,
  byFlag: Record<string, number> = {},
  high: number = 0,
  medium: number = 0,
  low: number = 0,
  firstSeen?: Date,
  lastSeen?: Date
): DeprecationAnalysisResult => ({
  usages: [],
  hasHighSeverity: high > 0,
  metrics: {
    totalUsages,
    byFlag,
    bySeverity: {
      [DeprecationSeverity.HIGH]: high,
      [DeprecationSeverity.MEDIUM]: medium,
      [DeprecationSeverity.LOW]: low,
    },
    firstSeen,
    lastSeen,
  },
});

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe("record", () => {
    it("should record metrics from analysis result", () => {
      collector.record(
        mockAnalysisResult(2, { "--flag1": 1, "--flag2": 1 }, 1, 1, 0)
      );

      const metrics = collector.getMetrics();
      expect(metrics.totalUsages).toBe(2);
      expect(metrics.byFlag["--flag1"]).toBe(1);
      expect(metrics.byFlag["--flag2"]).toBe(1);
      expect(metrics.bySeverity.high).toBe(1);
      expect(metrics.bySeverity.medium).toBe(1);
      expect(metrics.bySeverity.low).toBe(0);
    });

    it("should aggregate across multiple recordings", () => {
      collector.record(mockAnalysisResult(2, { "--flag1": 2 }, 2, 0, 0));
      collector.record(mockAnalysisResult(3, { "--flag2": 3 }, 1, 2, 0));
      collector.record(mockAnalysisResult(1, { "--flag1": 1 }, 0, 0, 1));

      const metrics = collector.getMetrics();
      expect(metrics.totalUsages).toBe(6);
      expect(metrics.byFlag["--flag1"]).toBe(3);
      expect(metrics.byFlag["--flag2"]).toBe(3);
      expect(metrics.bySeverity.high).toBe(3);
      expect(metrics.bySeverity.medium).toBe(2);
      expect(metrics.bySeverity.low).toBe(1);
    });

    it("should track first and last seen timestamps", () => {
      const date1 = new Date("2024-02-20T10:00:00Z");
      const date2 = new Date("2024-02-20T11:00:00Z");
      const date3 = new Date("2024-02-20T09:00:00Z");

      collector.record(mockAnalysisResult(1, {}, 1, 0, 0, date1, date1));
      collector.record(mockAnalysisResult(1, {}, 0, 1, 0, date2, date2));
      collector.record(mockAnalysisResult(1, {}, 0, 0, 1, date3, date3));

      const metrics = collector.getMetrics();
      expect(metrics.firstSeen).toEqual(date3); // earliest
      expect(metrics.lastSeen).toEqual(date2); // latest
    });

    it("should handle null first/last seen", () => {
      collector.record(mockAnalysisResult(1, {}, 1, 0, 0));
      collector.record(
        mockAnalysisResult(
          1,
          {},
          0,
          1,
          0,
          new Date("2024-02-20T10:00:00Z"),
          new Date("2024-02-20T10:00:00Z")
        )
      );

      const metrics = collector.getMetrics();
      expect(metrics.firstSeen).toBeDefined();
      expect(metrics.lastSeen).toBeDefined();
    });

    it("should increment invocation count", () => {
      expect(collector.getMetrics().invocationCount).toBe(0);

      collector.record(mockAnalysisResult(1, {}, 1, 0, 0));
      expect(collector.getMetrics().invocationCount).toBe(1);

      collector.record(mockAnalysisResult(2, {}, 0, 1, 1));
      expect(collector.getMetrics().invocationCount).toBe(2);
    });

    it("should handle zero usages", () => {
      collector.record(mockAnalysisResult(0, {}, 0, 0, 0));

      const metrics = collector.getMetrics();
      expect(metrics.totalUsages).toBe(0);
      expect(metrics.bySeverity.high).toBe(0);
      expect(metrics.bySeverity.medium).toBe(0);
      expect(metrics.bySeverity.low).toBe(0);
      expect(metrics.invocationCount).toBe(1);
    });
  });

  describe("reset", () => {
    it("should reset all metrics", () => {
      collector.record(mockAnalysisResult(5, { "--flag": 5 }, 3, 2, 0));
      collector.record(mockAnalysisResult(3, { "--other": 3 }, 0, 2, 1));

      expect(collector.getMetrics().totalUsages).toBe(8);
      expect(collector.getMetrics().invocationCount).toBe(2);

      collector.reset();

      const metrics = collector.getMetrics();
      expect(metrics.totalUsages).toBe(0);
      expect(metrics.byFlag).toEqual({});
      expect(metrics.bySeverity.high).toBe(0);
      expect(metrics.bySeverity.medium).toBe(0);
      expect(metrics.bySeverity.low).toBe(0);
      expect(metrics.invocationCount).toBe(0);
      expect(metrics.firstSeen).toBeUndefined();
      expect(metrics.lastSeen).toBeUndefined();
    });
  });

  describe("toJSON", () => {
    it("should serialize metrics to JSON", () => {
      collector.record(
        mockAnalysisResult(
          2,
          { "--test": 2 },
          2,
          0,
          0,
          new Date("2024-02-20T10:00:00Z"),
          new Date("2024-02-20T10:00:00Z")
        )
      );

      const json = collector.toJSON();
      expect(json).toBeTruthy();

      const parsed = JSON.parse(json);
      expect(parsed.totalUsages).toBe(2);
      expect(parsed.byFlag["--test"]).toBe(2);
      expect(parsed.invocationCount).toBe(1);
    });

    it("should handle empty collector", () => {
      const json = collector.toJSON();
      expect(json).toBeTruthy();

      const parsed = JSON.parse(json);
      expect(parsed.totalUsages).toBe(0);
      expect(parsed.invocationCount).toBe(0);
    });
  });

  describe("global collector", () => {
    afterEach(() => {
      resetMetricsCollector();
    });

    it("should return singleton instance", () => {
      const collector1 = getMetricsCollector();
      const collector2 = getMetricsCollector();
      expect(collector1).toBe(collector2);
    });

    it("should allow setting custom collector", () => {
      const customCollector = new MetricsCollector();
      setMetricsCollector(customCollector);

      const retrieved = getMetricsCollector();
      expect(retrieved).toBe(customCollector);
    });

    it("should reset global collector", () => {
      const collector1 = getMetricsCollector();
      collector1.record(mockAnalysisResult(1, {}, 1, 0, 0));

      resetMetricsCollector();
      const collector2 = getMetricsCollector();

      expect(collector1).not.toBe(collector2);
      expect(collector2.getMetrics().totalUsages).toBe(0);
    });

    it("should preserve existing data when not reset", () => {
      const collector = getMetricsCollector();
      collector.record(mockAnalysisResult(3, { "--flag": 3 }, 2, 1, 0));

      const sameCollector = getMetricsCollector();
      expect(sameCollector.getMetrics().totalUsages).toBe(3);
    });
  });
});
