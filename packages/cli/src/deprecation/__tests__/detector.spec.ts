/**
 * Unit tests for deprecation detector and warning formatter.
 */

import { Writable } from "stream";
import {
  DeprecationDetector,
  emitDeprecationWarnings,
  formatDeprecationSummary,
  formatDeprecationWarning,
  shouldFailOnDeprecation,
} from "../detector";
import {
  DeprecatedFlag,
  DeprecationConfig,
  DeprecationSeverity,
} from "../types";

const mockDeprecatedFlags: DeprecatedFlag[] = [
  {
    flag: "--old-flag",
    replacement: "--new-flag",
    message: "Use --new-flag instead",
    severity: DeprecationSeverity.HIGH,
    deprecatedIn: "1.0.0",
    removedIn: "2.0.0",
  },
  {
    flag: "--legacy-option",
    replacement: "config: output.legacy",
    message: "Use config file instead",
    severity: DeprecationSeverity.MEDIUM,
    deprecatedIn: "1.0.0",
    removedIn: "1.5.0",
  },
  {
    flag: "--verbose-mode",
    message: "This flag is deprecated",
    severity: DeprecationSeverity.LOW,
    deprecatedIn: "1.0.0",
  },
];

const mockConfig: DeprecationConfig = {
  deprecatedFlags: mockDeprecatedFlags,
  enableWarnings: true,
  enableMetrics: true,
  failOnHighSeverity: false,
};

describe("DeprecationDetector", () => {
  describe("analyze", () => {
    it("should detect deprecated flags in argv", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--old-flag"]);

      expect(result.usages.length).toBe(1);
      expect(result.usages[0].flag.flag).toBe("--old-flag");
    });

    it("should detect multiple deprecated flags", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([
        "node",
        "cli",
        "--old-flag",
        "--legacy-option",
      ]);

      expect(result.usages.length).toBe(2);
      expect(result.usages[0].flag.flag).toBe("--old-flag");
      expect(result.usages[1].flag.flag).toBe("--legacy-option");
    });

    it("should handle flags with values using = syntax", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--old-flag=value"]);

      expect(result.usages.length).toBe(1);
      expect(result.usages[0].flag.flag).toBe("--old-flag");
      expect(result.usages[0].value).toBe("value");
    });

    it("should track flag position in argv", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([
        "node",
        "cli",
        "scan",
        "--old-flag",
        "path",
      ]);

      expect(result.usages[0].position).toBe(3);
    });

    it("should not detect non-deprecated flags", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([
        "node",
        "cli",
        "--valid-flag",
        "--another-flag",
      ]);

      expect(result.usages.length).toBe(0);
    });

    it("should skip non-flag arguments", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([
        "node",
        "cli",
        "command",
        "path/to/file",
        "--old-flag",
      ]);

      expect(result.usages.length).toBe(1);
    });

    it("should detect hasHighSeverity correctly", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--old-flag"]);

      expect(result.hasHighSeverity).toBe(true);
    });

    it("should return false for hasHighSeverity when no high severity flags", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--legacy-option"]);

      expect(result.hasHighSeverity).toBe(false);
    });

    it("should calculate correct metrics", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([
        "node",
        "cli",
        "--old-flag",
        "--old-flag",
        "--legacy-option",
      ]);

      expect(result.metrics.totalUsages).toBe(3);
      expect(result.metrics.byFlag["--old-flag"]).toBe(2);
      expect(result.metrics.byFlag["--legacy-option"]).toBe(1);
      expect(result.metrics.bySeverity[DeprecationSeverity.HIGH]).toBe(2);
      expect(result.metrics.bySeverity[DeprecationSeverity.MEDIUM]).toBe(1);
    });

    it("should include correlation ID", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--old-flag"], "test-123");

      expect(result.usages[0].correlationId).toBe("test-123");
    });

    it("should generate correlation ID if not provided", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--old-flag"]);

      expect(result.usages[0].correlationId).toBeDefined();
      expect(result.usages[0].correlationId).toMatch(/^dep_/);
    });

    it("should handle empty argv", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([]);

      expect(result.usages.length).toBe(0);
      expect(result.hasHighSeverity).toBe(false);
      expect(result.metrics.totalUsages).toBe(0);
    });

    it("should be reusable after clear", () => {
      const detector = new DeprecationDetector(mockConfig);
      
      detector.analyze(["node", "cli", "--old-flag"]);
      expect(detector.getUsages().length).toBe(1);
      
      detector.clear();
      expect(detector.getUsages().length).toBe(0);
      
      const result = detector.analyze(["node", "cli", "--legacy-option"]);
      expect(result.usages.length).toBe(1);
    });
  });

  describe("formatDeprecationWarning", () => {
    it("should format a warning message", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--old-flag"]);
      const message = formatDeprecationWarning(result.usages[0]);

      expect(message).toContain("Deprecation Warning");
      expect(message).toContain("Use --new-flag instead");
      expect(message).toContain("--new-flag");
    });

    it("should include removal version if present", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--old-flag"]);
      const message = formatDeprecationWarning(result.usages[0]);

      expect(message).toContain("2.0.0");
    });

    it("should not include removal version if not present", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--verbose-mode"]);
      const message = formatDeprecationWarning(result.usages[0]);

      expect(message).not.toContain("Will be removed");
    });
  });

  describe("formatDeprecationSummary", () => {
    it("should format a summary with multiple usages", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([
        "node",
        "cli",
        "--old-flag",
        "--legacy-option",
      ]);
      const summary = formatDeprecationSummary(result);

      expect(summary).toContain("DEPRECATION WARNINGS");
      expect(summary).toContain("Total: 2");
    });

    it("should return empty string when no usages", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli"]);
      const summary = formatDeprecationSummary(result);

      expect(summary).toBe("");
    });

    it("should group duplicate flags", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([
        "node",
        "cli",
        "--old-flag",
        "--old-flag",
      ]);
      const summary = formatDeprecationSummary(result);

      // Should only show the warning once, but count both
      expect(summary).toContain("Total: 2");
    });

    it("should show severity breakdown", () => {
      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze([
        "node",
        "cli",
        "--old-flag",
        "--legacy-option",
        "--verbose-mode",
      ]);
      const summary = formatDeprecationSummary(result);

      expect(summary).toContain("High: 1");
      expect(summary).toContain("Medium: 1");
      expect(summary).toContain("Low: 1");
    });
  });

  describe("emitDeprecationWarnings", () => {
    it("should write warnings to provided stream", () => {
      const chunks: string[] = [];
      const mockStream = new Writable({
        write(chunk, encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      }) as NodeJS.WriteStream;

      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli", "--old-flag"]);
      emitDeprecationWarnings(result, mockStream);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("")).toContain("DEPRECATION WARNINGS");
    });

    it("should not write when no usages", () => {
      const chunks: string[] = [];
      const mockStream = new Writable({
        write(chunk, encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      }) as NodeJS.WriteStream;

      const detector = new DeprecationDetector(mockConfig);
      const result = detector.analyze(["node", "cli"]);
      emitDeprecationWarnings(result, mockStream);

      expect(chunks.length).toBe(0);
    });
  });

  describe("shouldFailOnDeprecation", () => {
    it("should return true when config enables and has high severity", () => {
      const config = { ...mockConfig, failOnHighSeverity: true };
      const detector = new DeprecationDetector(config);
      const result = detector.analyze(["node", "cli", "--old-flag"]);

      expect(shouldFailOnDeprecation(result, config)).toBe(true);
    });

    it("should return false when config disables", () => {
      const config = { ...mockConfig, failOnHighSeverity: false };
      const detector = new DeprecationDetector(config);
      const result = detector.analyze(["node", "cli", "--old-flag"]);

      expect(shouldFailOnDeprecation(result, config)).toBe(false);
    });

    it("should return false when no high severity flags", () => {
      const config = { ...mockConfig, failOnHighSeverity: true };
      const detector = new DeprecationDetector(config);
      const result = detector.analyze(["node", "cli", "--legacy-option"]);

      expect(shouldFailOnDeprecation(result, config)).toBe(false);
    });
  });
});
