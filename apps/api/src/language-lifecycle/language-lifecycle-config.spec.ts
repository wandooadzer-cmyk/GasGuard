import {
  DEFAULT_LANGUAGE_LIFECYCLE_CONFIG,
  loadLanguageLifecycleConfigFromEnv,
  resolveLanguageLifecycleConfig,
} from "./language-lifecycle-config";

describe("resolveLanguageLifecycleConfig", () => {
  it("returns the defaults when nothing is overridden", () => {
    expect(resolveLanguageLifecycleConfig()).toEqual(
      DEFAULT_LANGUAGE_LIFECYCLE_CONFIG,
    );
  });

  it("defaults to the pre-policy behaviour for unlisted languages", () => {
    expect(DEFAULT_LANGUAGE_LIFECYCLE_CONFIG.unlistedLanguageAction).toBe(
      "analyze",
    );
  });

  it("ignores undefined overrides", () => {
    expect(
      resolveLanguageLifecycleConfig({ maxFilesPerScan: undefined }),
    ).toEqual(DEFAULT_LANGUAGE_LIFECYCLE_CONFIG);
  });

  it("accepts a zero notice period", () => {
    expect(
      resolveLanguageLifecycleConfig({ minDeprecationNoticeDays: 0 })
        .minDeprecationNoticeDays,
    ).toBe(0);
  });

  it.each([
    [{ enabled: "yes" as unknown as boolean }, /enabled/],
    [{ minDeprecationNoticeDays: -1 }, /minDeprecationNoticeDays/],
    [{ minDeprecationNoticeDays: 1.5 }, /minDeprecationNoticeDays/],
    [{ maxFilesPerScan: 0 }, /maxFilesPerScan/],
    [{ maxLanguages: Number.NaN }, /maxLanguages/],
    [{ pinRetentionMs: -5 }, /pinRetentionMs/],
    [
      { unlistedLanguageAction: "drop" as unknown as "skip" },
      /unlistedLanguageAction/,
    ],
  ])("rejects %j", (overrides, message) => {
    expect(() => resolveLanguageLifecycleConfig(overrides)).toThrow(message);
  });
});

describe("loadLanguageLifecycleConfigFromEnv", () => {
  it("reads every variable", () => {
    expect(
      loadLanguageLifecycleConfigFromEnv({
        LANGUAGE_LIFECYCLE_ENABLED: "off",
        LANGUAGE_LIFECYCLE_MIN_NOTICE_DAYS: "30",
        LANGUAGE_LIFECYCLE_UNLISTED_ACTION: " SKIP ",
        LANGUAGE_LIFECYCLE_MAX_FILES: "500",
        LANGUAGE_LIFECYCLE_MAX_LANGUAGES: "8",
        LANGUAGE_LIFECYCLE_PIN_RETENTION_MS: "1000",
      }),
    ).toEqual({
      enabled: false,
      minDeprecationNoticeDays: 30,
      unlistedLanguageAction: "skip",
      maxFilesPerScan: 500,
      maxLanguages: 8,
      pinRetentionMs: 1000,
    });
  });

  it("keeps defaults for unset and blank variables", () => {
    expect(
      loadLanguageLifecycleConfigFromEnv({
        LANGUAGE_LIFECYCLE_MAX_FILES: "  ",
      }),
    ).toEqual(DEFAULT_LANGUAGE_LIFECYCLE_CONFIG);
  });

  it.each([
    ["LANGUAGE_LIFECYCLE_ENABLED", "maybe"],
    ["LANGUAGE_LIFECYCLE_MAX_FILES", "lots"],
    ["LANGUAGE_LIFECYCLE_UNLISTED_ACTION", "ignore"],
    ["LANGUAGE_LIFECYCLE_MIN_NOTICE_DAYS", "-3"],
  ])("fails fast on %s=%s", (key, value) => {
    expect(() => loadLanguageLifecycleConfigFromEnv({ [key]: value })).toThrow(
      RangeError,
    );
  });
});
