import { readFileSync } from "fs";
import * as path from "path";
import { Language } from "@engine/core/analyzer-interface";
import {
  DEFAULT_LANGUAGE_POLICY,
  buildPin,
  checkPolicyCoverage,
  checkPolicyTransition,
  compareVersions,
  detectLanguages,
  effectiveStage,
  evaluateDecisions,
  isValidDay,
  normalizePolicy,
  planScan,
  policyDigest,
  utcDay,
} from "./language-lifecycle-policy";
import {
  LanguageLifecycleEntry,
  LanguageLifecycleError,
  LanguageLifecyclePolicy,
  LanguageScanPin,
} from "./language-lifecycle-types";

const LIMITS = { maxLanguages: 64, minDeprecationNoticeDays: 90 };

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"),
  ) as T;
}

function policy(
  languages: Partial<LanguageLifecycleEntry>[],
  version = "1.0.0",
): LanguageLifecyclePolicy {
  return normalizePolicy(
    {
      version,
      languages: languages.map((l) => ({ extensions: [], ...l })),
    },
    LIMITS,
  );
}

function invalidPolicyErrors(input: unknown, limits = LIMITS): string[] {
  try {
    normalizePolicy(input, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(LanguageLifecycleError);
    expect((error as LanguageLifecycleError).code).toBe("INVALID_POLICY");
    expect((error as LanguageLifecycleError).retryable).toBe(false);
    return (error as LanguageLifecycleError).violations as string[];
  }
  throw new Error("expected INVALID_POLICY");
}

function pinFor(
  p: LanguageLifecyclePolicy,
  overrides: Partial<Parameters<typeof buildPin>[0]> = {},
): LanguageScanPin {
  return buildPin({
    tenantId: "tenant-a",
    scanId: "scan-1",
    policy: p,
    policyDigest: policyDigest(p),
    asOf: "2026-10-18",
    previewOptIns: [],
    enabled: true,
    unlistedAction: "analyze",
    pinnedAt: 0,
    ...overrides,
  });
}

describe("normalizePolicy", () => {
  it("accepts the built-in default, which covers every engine language", () => {
    const p = normalizePolicy(DEFAULT_LANGUAGE_POLICY, LIMITS);
    expect(p.languages.map((l) => l.language)).toEqual(
      Object.values(Language).sort(),
    );
    expect(p.languages.every((l) => l.stage === "supported")).toBe(true);
  });

  it("produces the same canonical form and digest regardless of order or extra keys", () => {
    const a = normalizePolicy(
      {
        version: "1.0.0",
        languages: [
          { language: "vyper", stage: "supported", extensions: [".vy"] },
          { language: "solidity", stage: "supported", extensions: [".sol"] },
        ],
      },
      LIMITS,
    );
    const b = normalizePolicy(
      {
        version: "1.0.0",
        note: "ignored",
        languages: [
          {
            language: "solidity",
            stage: "supported",
            extensions: [".sol"],
            owner: "x",
          },
          { language: "vyper", stage: "supported", extensions: [".vy"] },
        ],
      },
      LIMITS,
    );
    expect(b).toEqual(a);
    expect(policyDigest(b)).toBe(policyDigest(a));
    expect(a.languages.map((l) => l.language)).toEqual(["solidity", "vyper"]);
  });

  it("accepts a deprecation exactly at the minimum notice period", () => {
    expect(() =>
      policy([
        { language: "solidity", stage: "supported" },
        {
          language: "vyper",
          stage: "deprecated",
          deprecatedAt: "2026-01-01",
          sunsetAt: "2026-04-01", // 90 days
          replacement: "solidity",
        },
      ]),
    ).not.toThrow();
  });

  it.each<[string, unknown, RegExp]>([
    ["a non-object", "policy", /must be an object/],
    ["a bad version", { version: "1.0", languages: [{}] }, /version/],
    ["no languages", { version: "1.0.0", languages: [] }, /non-empty/],
    [
      "an upper-case language",
      {
        version: "1.0.0",
        languages: [
          { language: "Solidity", stage: "supported", extensions: [] },
        ],
      },
      /lower-case slug/,
    ],
    [
      "a duplicate language",
      {
        version: "1.0.0",
        languages: [
          { language: "rust", stage: "supported", extensions: [] },
          { language: "rust", stage: "preview", extensions: [] },
        ],
      },
      /more than once/,
    ],
    [
      "an unknown stage",
      {
        version: "1.0.0",
        languages: [{ language: "rust", stage: "beta", extensions: [] }],
      },
      /stage must be one of/,
    ],
    [
      "a shared extension",
      {
        version: "1.0.0",
        languages: [
          { language: "rust", stage: "supported", extensions: [".rs"] },
          { language: "soroban", stage: "supported", extensions: [".rs"] },
        ],
      },
      /already claimed by "rust"/,
    ],
    [
      "an extension without a dot",
      {
        version: "1.0.0",
        languages: [
          { language: "rust", stage: "supported", extensions: ["rs"] },
        ],
      },
      /extension "rs" is invalid/,
    ],
    [
      "an impossible date",
      {
        version: "1.0.0",
        languages: [
          {
            language: "vyper",
            stage: "deprecated",
            extensions: [],
            deprecatedAt: "2026-02-30",
            sunsetAt: "2027-01-01",
          },
        ],
      },
      /deprecatedAt must be a YYYY-MM-DD date/,
    ],
    [
      "a deprecation without a sunset",
      {
        version: "1.0.0",
        languages: [
          {
            language: "vyper",
            stage: "deprecated",
            extensions: [],
            deprecatedAt: "2026-01-01",
          },
        ],
      },
      /need deprecatedAt and sunsetAt/,
    ],
    [
      "a half-scheduled deprecation",
      {
        version: "1.0.0",
        languages: [
          {
            language: "vyper",
            stage: "supported",
            extensions: [],
            sunsetAt: "2027-01-01",
          },
        ],
      },
      /needs both deprecatedAt and sunsetAt/,
    ],
    [
      "too short a notice",
      {
        version: "1.0.0",
        languages: [
          {
            language: "vyper",
            stage: "deprecated",
            extensions: [],
            deprecatedAt: "2026-01-01",
            sunsetAt: "2026-03-31",
          },
        ],
      },
      /at least 90 days/,
    ],
    [
      "dates on a preview language",
      {
        version: "1.0.0",
        languages: [
          {
            language: "move",
            stage: "preview",
            extensions: [],
            sunsetAt: "2027-01-01",
          },
        ],
      },
      /retire them directly/,
    ],
    [
      "an unlisted replacement",
      {
        version: "1.0.0",
        languages: [
          {
            language: "javascript",
            stage: "retired",
            extensions: [],
            replacement: "typescript",
          },
        ],
      },
      /"typescript" is not listed/,
    ],
    [
      "a retired replacement",
      {
        version: "1.0.0",
        languages: [
          { language: "javascript", stage: "retired", extensions: [] },
          {
            language: "coffee",
            stage: "retired",
            extensions: [],
            replacement: "javascript",
          },
        ],
      },
      /"javascript" is retired/,
    ],
    [
      "a self replacement",
      {
        version: "1.0.0",
        languages: [
          {
            language: "rust",
            stage: "supported",
            extensions: [],
            replacement: "rust",
          },
        ],
      },
      /cannot be the language itself/,
    ],
  ])("rejects %s", (_name, input, message) => {
    expect(invalidPolicyErrors(input).join("\n")).toMatch(message);
  });

  it("rejects more languages than the limit", () => {
    const languages = ["a", "b", "c"].map((language) => ({
      language,
      stage: "supported",
      extensions: [],
    }));
    expect(
      invalidPolicyErrors(
        { version: "1.0.0", languages },
        {
          ...LIMITS,
          maxLanguages: 2,
        },
      ).join(),
    ).toMatch(/at most 2/);
  });

  it("reports every problem at once", () => {
    expect(
      invalidPolicyErrors({
        version: "x",
        languages: [
          { language: "rust", stage: "nope", extensions: [] },
          { language: "BAD", stage: "supported", extensions: [] },
        ],
      }),
    ).toHaveLength(3);
  });
});

describe("effectiveStage", () => {
  const scheduled: LanguageLifecycleEntry = {
    language: "vyper",
    stage: "supported",
    extensions: [],
    deprecatedAt: "2026-11-01",
    sunsetAt: "2027-02-01",
  };

  it.each([
    ["2026-10-31", "supported"],
    ["2026-11-01", "deprecated"],
    ["2027-01-31", "deprecated"],
    ["2027-02-01", "retired"],
    ["2030-01-01", "retired"],
  ])("on %s is %s", (asOf, stage) => {
    expect(effectiveStage(scheduled, asOf)).toBe(stage);
  });

  it("never moves preview or retired entries", () => {
    expect(
      effectiveStage(
        { language: "move", stage: "preview", extensions: [] },
        "2099-01-01",
      ),
    ).toBe("preview");
    expect(
      effectiveStage(
        { language: "js", stage: "retired", extensions: [] },
        "2000-01-01",
      ),
    ).toBe("retired");
  });
});

describe("evaluateDecisions", () => {
  const p = policy([
    { language: "cairo", stage: "preview" },
    { language: "javascript", stage: "retired", replacement: "typescript" },
    { language: "typescript", stage: "supported" },
  ]);

  it("skips preview languages unless the tenant opted in", () => {
    expect(evaluateDecisions(p, "2026-10-18", [], true)[0]).toMatchObject({
      language: "cairo",
      action: "skip",
      reason: "preview_not_enabled",
    });
    expect(
      evaluateDecisions(p, "2026-10-18", ["cairo"], true)[0],
    ).toMatchObject({
      action: "analyze",
      reason: "preview_opt_in",
    });
  });

  it("skips retired languages and names the replacement", () => {
    expect(evaluateDecisions(p, "2026-10-18", [], true)[1]).toEqual({
      language: "javascript",
      stage: "retired",
      action: "skip",
      reason: "retired",
      replacement: "typescript",
    });
  });

  it("analyzes everything when the policy is disabled", () => {
    const decisions = evaluateDecisions(p, "2026-10-18", [], false);
    expect(decisions.every((d) => d.action === "analyze")).toBe(true);
    expect(decisions.every((d) => d.reason === "policy_disabled")).toBe(true);
  });
});

describe("checkPolicyTransition", () => {
  const base = policy(
    [
      { language: "cairo", stage: "preview" },
      { language: "solidity", stage: "supported" },
      { language: "rust", stage: "supported" },
      {
        language: "vyper",
        stage: "deprecated",
        deprecatedAt: "2026-07-01",
        sunsetAt: "2027-01-31",
      },
    ],
    "1.0.0",
  );
  const asOf = "2026-10-18";
  const codes = (next: LanguageLifecyclePolicy) =>
    checkPolicyTransition(base, next, asOf, 90).map((v) => v.code);
  const withEntries = (
    replace: Record<string, Partial<LanguageLifecycleEntry> | null>,
    version = "1.1.0",
  ) =>
    policy(
      base.languages
        .filter((e) => replace[e.language] !== null)
        .map((e) => ({ ...e, ...(replace[e.language] ?? {}) })),
      version,
    );

  it("accepts a clean minor update", () => {
    expect(codes(withEntries({ cairo: { stage: "supported" } }))).toEqual([]);
  });

  it("requires a strictly greater version", () => {
    expect(codes(withEntries({}, "1.0.0"))).toEqual(["VERSION_NOT_INCREASED"]);
    expect(codes(withEntries({}, "0.9.9"))).toEqual(["VERSION_NOT_INCREASED"]);
  });

  it("forbids dropping a language instead of retiring it", () => {
    expect(codes(withEntries({ rust: null }))).toEqual(["LANGUAGE_REMOVED"]);
  });

  it("forbids retiring a supported language without deprecation", () => {
    expect(codes(withEntries({ solidity: { stage: "retired" } }))).toEqual([
      "SKIPPED_DEPRECATION",
    ]);
  });

  it("allows retiring a preview language directly", () => {
    expect(codes(withEntries({ cairo: { stage: "retired" } }))).toEqual([]);
  });

  it("requires the notice period to run from the publish day", () => {
    const backdated = {
      stage: "deprecated" as const,
      deprecatedAt: "2026-07-01",
      sunsetAt: "2026-12-01",
    };
    expect(codes(withEntries({ rust: backdated }))).toEqual([
      "INSUFFICIENT_NOTICE",
    ]);
    expect(
      codes(
        withEntries({
          rust: { ...backdated, sunsetAt: "2027-01-16" }, // exactly 90 days
        }),
      ),
    ).toEqual([]);
  });

  it("forbids pulling a sunset forward but allows pushing it back", () => {
    expect(codes(withEntries({ vyper: { sunsetAt: "2027-01-30" } }))).toEqual([
      "SUNSET_PULLED_FORWARD",
    ]);
    expect(codes(withEntries({ vyper: { sunsetAt: "2027-06-30" } }))).toEqual(
      [],
    );
  });

  it("allows reinstating a deprecated language", () => {
    expect(
      codes(
        withEntries({
          vyper: {
            stage: "supported",
            deprecatedAt: undefined,
            sunsetAt: undefined,
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("checkPolicyCoverage", () => {
  it("flags analyzable languages with no analyzer and unmanaged analyzer languages", () => {
    const p = policy([
      { language: "javascript", stage: "retired" },
      { language: "move", stage: "preview" },
      { language: "solidity", stage: "supported" },
    ]);
    expect(checkPolicyCoverage(p, ["solidity", "vyper"], "2026-10-18")).toEqual(
      [
        expect.objectContaining({ kind: "no_analyzer", language: "move" }),
        expect.objectContaining({
          kind: "unlisted_analyzer_language",
          language: "vyper",
        }),
      ],
    );
  });
});

describe("detectLanguages", () => {
  const p = normalizePolicy(DEFAULT_LANGUAGE_POLICY, LIMITS);

  it("detects by extension, case-insensitively, and ignores non-source files", () => {
    expect(
      Object.fromEntries(
        detectLanguages(
          [
            "src/Token.SOL",
            "README.md",
            "Makefile",
            "lib.rs",
            ".vy",
            "a.sol/b",
          ],
          p,
        ),
      ),
    ).toEqual({ "lib.rs": "rust", "src/Token.SOL": "solidity" });
  });

  it("prefers the longest claimed extension", () => {
    const custom = policy([
      { language: "typescript", stage: "supported", extensions: [".ts"] },
      { language: "tsdecl", stage: "supported", extensions: [".d.ts"] },
    ]);
    expect(
      Object.fromEntries(detectLanguages(["x.d.ts", "y.ts"], custom)),
    ).toEqual({ "x.d.ts": "tsdecl", "y.ts": "typescript" });
  });

  it("rejects malformed paths", () => {
    expect(() => detectLanguages(["ok.sol", ""], p)).toThrow(
      LanguageLifecycleError,
    );
  });
});

describe("buildPin", () => {
  const p = policy([{ language: "solidity", stage: "supported" }]);

  it("is deterministic and independent of ids and pin time", () => {
    const a = pinFor(p);
    const b = pinFor(p, { tenantId: "other", scanId: "s2", pinnedAt: 99 });
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("changes the fingerprint when anything that affects analysis changes", () => {
    const base = pinFor(p).fingerprint;
    expect(pinFor(p, { asOf: "2026-10-19" }).fingerprint).not.toBe(base);
    expect(pinFor(p, { unlistedAction: "skip" }).fingerprint).not.toBe(base);
    expect(pinFor(p, { enabled: false }).fingerprint).not.toBe(base);
    expect(pinFor(p, { policyDigest: "other" }).fingerprint).not.toBe(base);
  });

  it("forces unlisted languages to be analyzed when disabled", () => {
    expect(
      pinFor(p, { enabled: false, unlistedAction: "skip" }).unlistedAction,
    ).toBe("analyze");
  });
});

describe("planScan", () => {
  const p = policy([
    { language: "cairo", stage: "preview" },
    { language: "javascript", stage: "retired", replacement: "typescript" },
    { language: "solidity", stage: "supported" },
    { language: "typescript", stage: "supported" },
    {
      language: "vyper",
      stage: "deprecated",
      deprecatedAt: "2026-07-01",
      sunsetAt: "2027-01-31",
      replacement: "solidity",
    },
  ]);
  const map = (entries: Record<string, string>) =>
    new Map(Object.entries(entries));

  it("is complete when every file is analyzable", () => {
    const plan = planScan(
      pinFor(p),
      map({ "b.sol": "solidity", "a.ts": "typescript" }),
      10,
    );
    expect(plan.status).toBe("complete");
    expect([...plan.analyze.keys()]).toEqual(["a.ts", "b.sol"]);
    expect(plan.skipped).toEqual([]);
  });

  it("is partial, with reasons, when some files are skipped", () => {
    const plan = planScan(
      pinFor(p),
      map({ "a.sol": "solidity", "z.js": "javascript", "m.cairo": "cairo" }),
      10,
    );
    expect(plan.status).toBe("partial");
    expect(plan.skipped).toEqual([
      { path: "m.cairo", language: "cairo", reason: "preview_not_enabled" },
      { path: "z.js", language: "javascript", reason: "retired" },
    ]);
  });

  it("is unsupported when nothing can be analyzed", () => {
    expect(planScan(pinFor(p), map({ "z.js": "javascript" }), 10).status).toBe(
      "unsupported",
    );
  });

  it("is empty when there are no source files", () => {
    expect(planScan(pinFor(p), new Map(), 10).status).toBe("empty");
  });

  it("warns once per deprecated language with a file count", () => {
    const plan = planScan(
      pinFor(p),
      map({ "a.vy": "vyper", "b.vy": "vyper", "c.sol": "solidity" }),
      10,
    );
    expect(plan.warnings).toEqual([
      {
        language: "vyper",
        files: 2,
        sunsetAt: "2027-01-31",
        replacement: "solidity",
        message:
          'Language "vyper" is deprecated and will no longer be analyzed from 2027-01-31. Migrate to "solidity".',
      },
    ]);
  });

  it("treats unlisted languages per the pinned action", () => {
    const files = map({ "a.move": "move", "b.sol": "solidity" });
    expect(planScan(pinFor(p), files, 10).analyze.get("a.move")).toBe("move");
    expect(
      planScan(pinFor(p, { unlistedAction: "skip" }), files, 10).skipped,
    ).toEqual([
      { path: "a.move", language: "move", reason: "unlisted_language" },
    ]);
  });

  it("normalizes language case from the engine map", () => {
    expect(planScan(pinFor(p), map({ "a.sol": "Solidity" }), 10).status).toBe(
      "complete",
    );
  });

  it("accepts exactly maxFiles files and rejects one more", () => {
    const files = map({ "a.sol": "solidity", "b.sol": "solidity" });
    expect(planScan(pinFor(p), files, 2).analyze.size).toBe(2);
    expect(() => planScan(pinFor(p), files, 1)).toThrow(/at most 1 files/);
  });

  it.each([
    ["a non-map", {} as Map<string, string>],
    ["an empty language", new Map([["a.sol", " "]])],
    ["a non-string language", new Map([["a.sol", 7 as unknown as string]])],
    ["a NUL in a path", new Map([["a\u0000.sol", "solidity"]])],
  ])("rejects %s as INVALID_INPUT", (_name, languageMap) => {
    try {
      planScan(pinFor(p), languageMap, 10);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as LanguageLifecycleError).code).toBe("INVALID_INPUT");
    }
  });

  it("gives identical plans regardless of input order", () => {
    const forward = planScan(
      pinFor(p),
      map({ "a.sol": "solidity", "b.js": "javascript", "c.vy": "vyper" }),
      10,
    );
    const reversed = planScan(
      pinFor(p),
      new Map([
        ["c.vy", "vyper"],
        ["b.js", "javascript"],
        ["a.sol", "solidity"],
      ]),
      10,
    );
    expect([...reversed.analyze]).toEqual([...forward.analyze]);
    expect(reversed).toEqual(forward);
  });
});

describe("helpers", () => {
  it("formats UTC days", () => {
    expect(utcDay(Date.UTC(2026, 9, 18, 23, 59, 59))).toBe("2026-10-18");
    expect(() => utcDay(Number.NaN)).toThrow(LanguageLifecycleError);
  });

  it("validates days", () => {
    expect(isValidDay("2028-02-29")).toBe(true);
    expect(isValidDay("2027-02-29")).toBe(false);
    expect(isValidDay("2026-1-01")).toBe(false);
    expect(isValidDay(20261018)).toBe(false);
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.0.0", "0.0.1")).toBeLessThan(0);
  });
});

/**
 * Frozen decisions and fingerprints around the scheduled deprecation and
 * sunset boundaries. A change here means scan results for existing commits
 * would no longer be reproducible, so update the fixture only deliberately.
 */
describe("regression: sunset boundaries", () => {
  interface RegressionFixture {
    policyDigest: string;
    cases: {
      asOf: string;
      previewOptIns: string[];
      decisions: unknown[];
      fingerprint: string;
    }[];
    detection: Record<string, string>;
  }
  const frozen = fixture<RegressionFixture>("sunset-boundary-regression.json");
  const p = normalizePolicy(fixture("sunset-boundary-policy.json"), LIMITS);

  it("keeps the canonical policy digest", () => {
    expect(policyDigest(p)).toBe(frozen.policyDigest);
  });

  it.each(
    frozen.cases.map((c) => [c.asOf, c.previewOptIns.join(",") || "-", c]),
  )("on %s with opt-ins %s", (_asOf, _optIns, expected) => {
    const pin = pinFor(p, {
      asOf: expected.asOf,
      previewOptIns: expected.previewOptIns,
    });
    expect(pin.decisions).toEqual(expected.decisions);
    expect(pin.fingerprint).toBe(expected.fingerprint);
  });

  it("keeps extension detection stable", () => {
    expect(
      Object.fromEntries(
        detectLanguages(
          [
            "Contracts/Token.SOL",
            "a/b.vy",
            "lib/x.cairo",
            "noext",
            ".vy",
            "dir.sol/readme",
          ],
          p,
        ),
      ),
    ).toEqual(frozen.detection);
  });
});
