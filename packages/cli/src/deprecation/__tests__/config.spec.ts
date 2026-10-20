/**
 * Unit tests for deprecation configuration and flag lookup.
 */

import {
  DEPRECATED_FLAGS,
  DEFAULT_DEPRECATION_CONFIG,
  createFlagLookup,
  loadDeprecationConfig,
} from "../config";
import { DeprecationSeverity } from "../types";

describe("Deprecation Config", () => {
  describe("DEPRECATED_FLAGS", () => {
    it("should contain valid flag definitions", () => {
      expect(DEPRECATED_FLAGS).toBeDefined();
      expect(Array.isArray(DEPRECATED_FLAGS)).toBe(true);
      expect(DEPRECATED_FLAGS.length).toBeGreaterThan(0);
    });

    it("should have required fields for each flag", () => {
      for (const flag of DEPRECATED_FLAGS) {
        expect(flag.flag).toBeDefined();
        expect(typeof flag.flag).toBe("string");
        expect(flag.flag.length).toBeGreaterThan(0);
        expect(flag.message).toBeDefined();
        expect(typeof flag.message).toBe("string");
        expect(flag.severity).toBeDefined();
        expect(Object.values(DeprecationSeverity)).toContain(flag.severity);
        expect(flag.deprecatedIn).toBeDefined();
        expect(typeof flag.deprecatedIn).toBe("string");
      }
    });

    it("should not have duplicate flags", () => {
      const flagNames = DEPRECATED_FLAGS.map((f) => f.flag);
      const uniqueFlags = new Set(flagNames);
      expect(uniqueFlags.size).toBe(flagNames.length);
    });
  });

  describe("DEFAULT_DEPRECATION_CONFIG", () => {
    it("should have valid default configuration", () => {
      expect(DEFAULT_DEPRECATION_CONFIG.deprecatedFlags).toBeDefined();
      expect(typeof DEFAULT_DEPRECATION_CONFIG.enableWarnings).toBe("boolean");
      expect(typeof DEFAULT_DEPRECATION_CONFIG.enableMetrics).toBe("boolean");
      expect(typeof DEFAULT_DEPRECATION_CONFIG.failOnHighSeverity).toBe("boolean");
    });

    it("should enable warnings by default", () => {
      expect(DEFAULT_DEPRECATION_CONFIG.enableWarnings).toBe(true);
    });

    it("should enable metrics by default", () => {
      expect(DEFAULT_DEPRECATION_CONFIG.enableMetrics).toBe(true);
    });

    it("should not fail on high severity by default", () => {
      expect(DEFAULT_DEPRECATION_CONFIG.failOnHighSeverity).toBe(false);
    });
  });

  describe("createFlagLookup", () => {
    it("should create a lookup map from flags", () => {
      const lookup = createFlagLookup(DEPRECATED_FLAGS);
      expect(lookup).toBeInstanceOf(Map);
      expect(lookup.size).toBeGreaterThan(0);
    });

    it("should support lookup with double dashes", () => {
      const lookup = createFlagLookup(DEPRECATED_FLAGS);
      const flag = DEPRECATED_FLAGS[0];
      const normalized = flag.flag.startsWith("--") ? flag.flag : `--${flag.flag}`;
      expect(lookup.has(normalized)).toBe(true);
    });

    it("should support lookup without dashes", () => {
      const lookup = createFlagLookup(DEPRECATED_FLAGS);
      const flag = DEPRECATED_FLAGS[0];
      const withoutDashes = flag.flag.replace(/^-+/, "");
      expect(lookup.has(withoutDashes)).toBe(true);
    });

    it("should return correct flag object", () => {
      const lookup = createFlagLookup(DEPRECATED_FLAGS);
      const flag = DEPRECATED_FLAGS[0];
      const retrieved = lookup.get(flag.flag);
      expect(retrieved).toBe(flag);
    });

    it("should handle empty array", () => {
      const lookup = createFlagLookup([]);
      expect(lookup.size).toBe(0);
    });
  });

  describe("loadDeprecationConfig", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should return default config when no env vars set", () => {
      delete process.env.GASGUARD_DEPRECATION_WARNINGS;
      delete process.env.GASGUARD_DEPRECATION_METRICS;
      delete process.env.GASGUARD_FAIL_ON_DEPRECATED;

      const config = loadDeprecationConfig();
      expect(config.enableWarnings).toBe(true);
      expect(config.enableMetrics).toBe(true);
      expect(config.failOnHighSeverity).toBe(false);
    });

    it("should disable warnings when env var is false", () => {
      process.env.GASGUARD_DEPRECATION_WARNINGS = "false";
      const config = loadDeprecationConfig();
      expect(config.enableWarnings).toBe(false);
    });

    it("should disable metrics when env var is false", () => {
      process.env.GASGUARD_DEPRECATION_METRICS = "false";
      const config = loadDeprecationConfig();
      expect(config.enableMetrics).toBe(false);
    });

    it("should enable fail on deprecated when env var is true", () => {
      process.env.GASGUARD_FAIL_ON_DEPRECATED = "true";
      const config = loadDeprecationConfig();
      expect(config.failOnHighSeverity).toBe(true);
    });

    it("should handle multiple env var overrides", () => {
      process.env.GASGUARD_DEPRECATION_WARNINGS = "false";
      process.env.GASGUARD_DEPRECATION_METRICS = "false";
      process.env.GASGUARD_FAIL_ON_DEPRECATED = "true";

      const config = loadDeprecationConfig();
      expect(config.enableWarnings).toBe(false);
      expect(config.enableMetrics).toBe(false);
      expect(config.failOnHighSeverity).toBe(true);
    });

    it("should ignore non-false/true values", () => {
      process.env.GASGUARD_DEPRECATION_WARNINGS = "yes";
      process.env.GASGUARD_FAIL_ON_DEPRECATED = "no";

      const config = loadDeprecationConfig();
      expect(config.enableWarnings).toBe(true); // not "false", so default
      expect(config.failOnHighSeverity).toBe(false); // not "true", so default
    });
  });
});
