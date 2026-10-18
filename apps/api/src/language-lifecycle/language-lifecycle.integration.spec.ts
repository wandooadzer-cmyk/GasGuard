/**
 * Integration tests across the language lifecycle boundaries: operator-facing
 * service, worker adapter, the durable file store (including service restarts
 * over the same storage), and the engine's real `AnalyzerRegistry`.
 */

import { createHash } from "crypto";
import { promises as fs, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import {
  AnalysisResult,
  Analyzer,
  AnalyzerConfig,
  Language,
  Rule,
  Severity,
} from "@engine/core/analyzer-interface";
import { AnalyzerRegistry } from "@engine/core/analyzer-registry";
import { LanguageLifecycleConfig } from "./language-lifecycle-config";
import {
  LanguageLifecycleLogFields,
  LanguageLifecycleLogLevel,
  LanguageLifecycleLogger,
} from "./language-lifecycle-metrics";
import { detectLanguages, normalizePolicy } from "./language-lifecycle-policy";
import { FileLanguageLifecycleStore } from "./language-lifecycle-store";
import {
  LanguageLifecycleError,
  LanguageLifecyclePolicy,
  LanguageScanPlan,
  SkippedFile,
  LanguageWarning,
} from "./language-lifecycle-types";
import { LanguageLifecycleService } from "./language-lifecycle.service";
import { runScanWithLanguagePolicy } from "./language-lifecycle-worker";

interface RepositoryFixture {
  tenantId: string;
  repository: string;
  commit: string;
  commitDate: string;
  scanId: string;
  files: string[];
  sorobanPrefixes: string[];
}

interface ExpectedFixture {
  policyDigest: string;
  fingerprint: string;
  status: string;
  analyze: Record<string, string>;
  skipped: SkippedFile[];
  warnings: LanguageWarning[];
}

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"),
  ) as T;
}

const governed = fixture<LanguageLifecyclePolicy>("governed-policy.json");
const repo = fixture<RepositoryFixture>("soroban-dex-repository.json");
const expected = fixture<ExpectedFixture>("soroban-dex-expected.json");
const DAY = 24 * 60 * 60 * 1000;

class CapturingLogger implements LanguageLifecycleLogger {
  readonly lines: string[] = [];
  log(
    level: LanguageLifecycleLogLevel,
    event: string,
    fields: LanguageLifecycleLogFields,
  ): void {
    this.lines.push(JSON.stringify({ level, event, ...fields }));
  }
}

/**
 * Stand-in analyzer: one finding per file, a pure function of the commit, the
 * path, and the analyzer, as real analysis must be. Records what it was given.
 */
class StubAnalyzer implements Analyzer {
  readonly received: string[] = [];
  constructor(private readonly language: Language) {}
  getName() {
    return `${this.language}-stub`;
  }
  getVersion() {
    return "1.0.0";
  }
  async analyze(code: string, filePath: string): Promise<AnalysisResult> {
    return this.analyzeMultiple(new Map([[filePath, code]]));
  }
  async analyzeMultiple(
    files: Map<string, string>,
    _config?: AnalyzerConfig,
  ): Promise<AnalysisResult> {
    const findings = [...files].map(([file, code]) => {
      this.received.push(file);
      return {
        ruleId: `${this.language}-stub-rule`,
        message: createHash("sha256")
          .update(`${file}\u0000${code}`)
          .digest("hex")
          .slice(0, 12),
        severity: Severity.LOW,
        location: { file, startLine: 1, endLine: 1 },
      };
    });
    return {
      findings,
      filesAnalyzed: files.size,
      analysisTime: 0,
      analyzerVersion: "1.0.0",
      summary: {
        critical: 0,
        high: 0,
        medium: 0,
        low: findings.length,
        info: 0,
      },
    };
  }
  supportsLanguage(language: Language | string) {
    return language === this.language;
  }
  getSupportedLanguages() {
    return [this.language];
  }
  getRules(): Rule[] {
    return [];
  }
  getRule() {
    return undefined;
  }
  validateConfig() {
    return [];
  }
  async initialize() {}
  async dispose() {}
}

let rootDir: string;
let logger: CapturingLogger;
let now: number;
let registry: AnalyzerRegistry;
let analyzers: Map<string, StubAnalyzer>;

/** A fresh service over the same directory, i.e. a restarted process. */
function boot(config: Partial<LanguageLifecycleConfig> = {}) {
  return new LanguageLifecycleService({
    store: new FileLanguageLifecycleStore(rootDir),
    logger,
    clock: () => now,
    config,
  });
}

/** The worker's view of the repository: path → language at the commit. */
function repositoryLanguageMap(files = repo.files): Map<string, string> {
  const policy = normalizePolicy(governed, {
    maxLanguages: 64,
    minDeprecationNoticeDays: 0,
  });
  const map = detectLanguages(files, policy);
  for (const file of map.keys()) {
    if (repo.sorobanPrefixes.some((prefix) => file.startsWith(prefix))) {
      map.set(file, Language.SOROBAN);
    }
  }
  return map;
}

/** Repository content is a pure function of the commit and path. */
function contents(languageMap: Map<string, string>): Map<string, string> {
  return new Map(
    [...languageMap.keys()].map((file) => [file, `${repo.commit}:${file}`]),
  );
}

async function scanRepository(
  service: LanguageLifecycleService,
  scanId = repo.scanId,
  tenantId = repo.tenantId,
  languageMap = repositoryLanguageMap(),
) {
  return runScanWithLanguagePolicy(
    service,
    { tenantId, scanId, languageMap, asOf: repo.commitDate },
    async (analyzable, plan: LanguageScanPlan) => {
      const result = await registry.analyzeMultiple(
        contents(analyzable),
        analyzable,
      );
      return {
        findings: result.findings.map(
          (f) => `${f.location.file}|${f.ruleId}|${f.message}`,
        ),
        skipped: plan.skipped,
        warnings: plan.warnings,
      };
    },
  );
}

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "gasguard-langlc-int-"));
  logger = new CapturingLogger();
  now = Date.UTC(2026, 9, 18, 9);
  registry = new AnalyzerRegistry();
  analyzers = new Map();
  // A javascript and a cairo analyzer stay registered: the policy, not the
  // registry, decides they do not run.
  for (const language of [
    Language.CAIRO,
    Language.JAVASCRIPT,
    Language.RUST,
    Language.SOLIDITY,
    Language.SOROBAN,
    Language.TYPESCRIPT,
    Language.VYPER,
  ]) {
    const analyzer = new StubAnalyzer(language);
    analyzers.set(language, analyzer);
    registry.register(analyzer);
  }
  await boot().publishPolicy(governed, {
    force: true,
    reason: "javascript analyzer withdrawn",
  });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe("realistic repository: Soroban DEX with EVM and Starknet bridges", () => {
  it("analyzes supported and deprecated languages and reports the rest", async () => {
    const { result, plan, resolution } = await scanRepository(boot());

    expect(resolution.pin.policyDigest).toBe(expected.policyDigest);
    expect(plan.fingerprint).toBe(expected.fingerprint);
    expect(plan.status).toBe(expected.status);
    expect(Object.fromEntries(plan.analyze)).toEqual(expected.analyze);
    expect(result.skipped).toEqual(expected.skipped);
    expect(result.warnings).toEqual(expected.warnings);

    // Only planned files reached the engine, each through its own analyzer.
    const received = [...analyzers.values()].flatMap((a) => a.received).sort();
    expect(received).toEqual(Object.keys(expected.analyze).sort());
    expect(analyzers.get(Language.JAVASCRIPT)!.received).toEqual([]);
    expect(analyzers.get(Language.CAIRO)!.received).toEqual([]);
    expect(result.findings).toHaveLength(Object.keys(expected.analyze).length);
  });

  it("produces identical findings for the same commit, config and policy", async () => {
    const first = await scanRepository(boot(), "scan-a");
    now += 5 * DAY;
    const second = await scanRepository(boot(), "scan-b");
    expect(second.result).toEqual(first.result);
    expect(second.plan.fingerprint).toBe(first.plan.fingerprint);
  });

  it("keeps a retried scan on its pin across restarts, policy changes and the sunset", async () => {
    const languageMap = repositoryLanguageMap();
    // First attempt fails after pinning, before the analyzers finish.
    await expect(
      runScanWithLanguagePolicy(
        boot(),
        { tenantId: repo.tenantId, scanId: repo.scanId, languageMap },
        async () => {
          throw new Error("worker lost its lease");
        },
      ),
    ).rejects.toThrow("worker lost its lease");

    // Meanwhile: the tenant opts into cairo, and vyper's sunset passes.
    const operator = boot();
    await operator.setPreviewOptIns(repo.tenantId, ["cairo"]);
    now = Date.UTC(2027, 1, 15);

    const retry = await scanRepository(boot());
    expect(retry.resolution.status).toBe("reused");
    expect(retry.plan.analyze.get("bridge/evm/legacy/Vault.vy")).toBe("vyper");
    expect(retry.plan.analyze.has("bridge/starknet/src/bridge.cairo")).toBe(
      false,
    );

    // A new scan of the same repository sees today's decisions.
    const fresh = await runScanWithLanguagePolicy(
      boot(),
      { tenantId: repo.tenantId, scanId: "scan-after-sunset", languageMap },
      async (analyzable) => [...analyzable.keys()],
    );
    expect(fresh.result).not.toContain("bridge/evm/legacy/Vault.vy");
    expect(fresh.result).toContain("bridge/starknet/src/bridge.cairo");
    expect(fresh.plan.skipped).toContainEqual({
      path: "bridge/evm/legacy/Vault.vy",
      language: "vyper",
      reason: "retired",
    });
  });
});

describe("tenant isolation", () => {
  it("applies one tenant's opt-ins only to that tenant, even with colliding scan ids", async () => {
    const service = boot();
    await service.setPreviewOptIns("tenant-starknet", ["cairo"]);
    const optedIn = await scanRepository(boot(), "scan-1", "tenant-starknet");
    const other = await scanRepository(boot(), "scan-1", repo.tenantId);
    expect(optedIn.plan.analyze.has("bridge/starknet/src/bridge.cairo")).toBe(
      true,
    );
    expect(other.plan.analyze.has("bridge/starknet/src/bridge.cairo")).toBe(
      false,
    );
    expect(other.resolution.status).toBe("created");
  });
});

describe("failure semantics", () => {
  it("fails a repository with no analyzable language as non-retryable, without running analyzers", async () => {
    const scan = jest.fn();
    const error = await runScanWithLanguagePolicy(
      boot(),
      {
        tenantId: repo.tenantId,
        scanId: "legacy-js",
        languageMap: repositoryLanguageMap([
          "scripts/a.js",
          "scripts/b.mjs",
          "README.md",
        ]),
      },
      scan,
    ).catch((e: LanguageLifecycleError) => e);
    expect(error).toMatchObject({
      code: "UNSUPPORTED_REPOSITORY",
      retryable: false,
    });
    expect((error as Error).message).toContain("javascript");
    expect(scan).not.toHaveBeenCalled();
  });

  it("runs a repository with no source files, as the registry did before", async () => {
    const { plan, result } = await runScanWithLanguagePolicy(
      boot(),
      { tenantId: repo.tenantId, scanId: "docs-only", languageMap: new Map() },
      async (analyzable) =>
        (await registry.analyzeMultiple(new Map(), analyzable)).findings,
    );
    expect(plan.status).toBe("empty");
    expect(result).toEqual([]);
  });

  it("reports an unreachable store as retryable before any analysis", async () => {
    const blocker = path.join(rootDir, "not-a-directory");
    await fs.writeFile(blocker, "");
    const broken = new LanguageLifecycleService({
      store: new FileLanguageLifecycleStore(path.join(blocker, "store")),
      logger,
      clock: () => now,
    });
    const scan = jest.fn();
    const error = await runScanWithLanguagePolicy(
      broken,
      {
        tenantId: repo.tenantId,
        scanId: "s",
        languageMap: repositoryLanguageMap(),
      },
      scan,
    ).catch((e: LanguageLifecycleError) => e);
    expect(error).toMatchObject({ code: "STORE_UNAVAILABLE", retryable: true });
    expect(scan).not.toHaveBeenCalled();
    expect(logger.lines.join("\n")).not.toContain(rootDir);
  });
});

describe("backward compatibility", () => {
  it("analyzes every language when the kill switch is off", async () => {
    const { plan } = await scanRepository(boot({ enabled: false }));
    expect(plan.status).toBe("complete");
    expect(plan.analyze.size).toBe(repositoryLanguageMap().size);
  });

  it("analyzes everything under the built-in default before any policy is published", async () => {
    await fs.rm(path.join(rootDir, "policy"), { recursive: true, force: true });
    const { plan, resolution } = await scanRepository(boot(), "pre-policy");
    expect(resolution.pin.policyVersion).toBe("0.0.0");
    expect(plan.status).toBe("complete");
  });
});

describe("analyzer coverage", () => {
  it("flags policy languages that no registered analyzer supports", async () => {
    const issues = await boot().checkCoverage(
      registry.getSupportedLanguages().map(String),
    );
    expect(issues).toEqual([
      expect.objectContaining({ kind: "no_analyzer", language: "move" }),
    ]);
  });
});

describe("observability", () => {
  it("never logs file paths, repository names, or content", async () => {
    await scanRepository(boot());
    const text = logger.lines.join("\n");
    expect(text).toContain('"event":"scan_planned"');
    for (const forbidden of [
      "contracts/amm",
      "Vault.vy",
      repo.repository,
      repo.commit,
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("exports metrics with bounded labels", async () => {
    const service = boot();
    await scanRepository(service);
    const policy = await service.getPolicy();
    const text = service.metrics.toPrometheus(policy, repo.commitDate);
    expect(text).toContain(
      'gasguard_language_files_skipped_total{language="cairo",reason="preview_not_enabled"} 1',
    );
    expect(text).toContain(
      'gasguard_language_deprecated_files_total{language="vyper"} 1',
    );
    expect(text).toContain(
      'gasguard_language_stage{language="javascript",stage="retired"} 1',
    );
    expect(text).not.toContain(repo.tenantId);
  });
});
