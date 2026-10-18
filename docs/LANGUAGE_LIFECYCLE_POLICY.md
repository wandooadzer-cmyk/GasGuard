# Supported-Language Lifecycle Policy

Part of the **Release and Governance** workstream.

GasGuard analyzes several smart-contract and tooling languages. Today a language is either handled by
an analyzer or silently produces zero findings. That second outcome looks the same as a clean
result. There is also no way to announce that a language is going away, to try a new one with
selected tenants, or to stop analyzing one without breaking someone's scans without warning. The
language lifecycle policy fixes all of this. Each language gets a documented stage with scheduled
dates. Scans pin the decisions they used, and anything a scan does not analyze is reported with a
reason.

| Piece | Location |
| --- | --- |
| Types and error codes | `apps/api/src/language-lifecycle/language-lifecycle-types.ts` |
| Configuration (`LANGUAGE_LIFECYCLE_*`) | `apps/api/src/language-lifecycle/language-lifecycle-config.ts` |
| Pure policy logic: validation, stages, governance, detection, planning | `apps/api/src/language-lifecycle/language-lifecycle-policy.ts` |
| Persistence boundary (in-memory and file stores) | `apps/api/src/language-lifecycle/language-lifecycle-store.ts` |
| Operator, tenant and worker API | `apps/api/src/language-lifecycle/language-lifecycle.service.ts` |
| Worker adapter | `apps/api/src/language-lifecycle/language-lifecycle-worker.ts` |
| Metrics and structured logs | `apps/api/src/language-lifecycle/language-lifecycle-metrics.ts` |
| Fixtures (realistic repository, sunset-boundary regression) | `apps/api/src/language-lifecycle/__fixtures__/` |

The module depends only on the engine's `Language` enum. Its output is the same path-to-language
map that `AnalyzerRegistry.analyzeMultiple` already takes, so the registry and analyzers are
unchanged. Existing scan paths behave exactly as before until a worker opts in through
`runScanWithLanguagePolicy`.

## Lifecycle

```
preview ──► supported ──► deprecated ──► retired
   │                                       ▲
   └───────────────────────────────────────┘   (preview may retire directly)
```

| Stage | Analyzed? | Reported as |
| --- | --- | --- |
| `preview` | Only for tenants that opted in | Skipped (`preview_not_enabled`) for everyone else |
| `supported` | Yes | — |
| `deprecated` | Yes | One warning per language with file count, `sunsetAt`, and `replacement` |
| `retired` | No | Skipped (`retired`), with `replacement` in the decision |

A policy entry declares a stage and may schedule the next steps by date (UTC days, `YYYY-MM-DD`):

```json
{
  "version": "1.2.0",
  "languages": [
    { "language": "cairo", "stage": "preview", "extensions": [".cairo"] },
    { "language": "solidity", "stage": "supported", "extensions": [".sol"] },
    { "language": "soroban", "stage": "supported", "extensions": [] },
    {
      "language": "vyper", "stage": "supported", "extensions": [".vy"],
      "deprecatedAt": "2026-11-01", "sunsetAt": "2027-02-01", "replacement": "solidity"
    }
  ]
}
```

The effective stage on day `asOf` is computed as follows:

- `preview` and `retired` never move on their own.
- From `deprecatedAt` (inclusive), the language is `deprecated`.
- From `sunsetAt` (inclusive), the language is `retired`.

So an operator can publish a whole deprecation schedule once, and no change is needed on the day
itself.

### Validation rules (`INVALID_POLICY`)

- `version` is `MAJOR.MINOR.PATCH`, and there is at least one language and at most `maxLanguages`.
- `language` is a lower-case slug (`^[a-z][a-z0-9_-]{0,31}$`), listed once. Use the engine's names
  (`Language` enum) so the registry agrees.
- `extensions` are lower-case with a leading dot, up to three segments (`.d.ts`), and at most 16
  characters. An extension belongs to one language only. A language may list none; for example,
  `soroban` shares `.rs` with `rust`, and the caller tells them apart.
- `deprecated` needs both `deprecatedAt` and `sunsetAt`. A scheduled deprecation on a `supported`
  entry also needs both. `preview` carries no dates.
- `sunsetAt − deprecatedAt ≥ minDeprecationNoticeDays`.
- `replacement` must be another listed language that is not retired.

Every problem is reported at once in `error.violations`. Canonicalization drops unknown keys and
sorts languages and extensions, so two policies that mean the same thing have the same `digest`.

### Governance between versions (`TRANSITION_REJECTED`)

When a policy is published, it is compared with the current one (or with the built-in default if
none has been published yet), evaluated on the publish day:

| Code | Rule | Forceable |
| --- | --- | --- |
| `VERSION_NOT_INCREASED` | The new version must be strictly greater | No |
| `LANGUAGE_REMOVED` | Languages are retired, never deleted, so their files keep being reported | Yes |
| `SKIPPED_DEPRECATION` | `supported` cannot become `retired` without a deprecation period (`preview` can) | Yes |
| `INSUFFICIENT_NOTICE` | A newly announced `sunsetAt` must be at least `minDeprecationNoticeDays` after the publish day; this blocks back-dating `deprecatedAt` | Yes |
| `SUNSET_PULLED_FORWARD` | An announced sunset may move later, never earlier | Yes |

`publishPolicy(policy, { force: true, reason })` overrides forceable violations. The reason and the
overridden codes are stored in the policy history, the publish is logged at `warn`, and it is
counted as `forced`. Reinstating a deprecated or retired language is always allowed.

## Determinism

Scan results must be identical for the same commit, configuration, and rule-pack version. The
language decisions for a scan are a pure function of:

- the policy's canonical `digest` and `version`,
- the `asOf` day the dates are evaluated at,
- the tenant's preview opt-ins,
- `enabled` and `unlistedLanguageAction`.

The first `resolveForScan` writes these decisions to a write-once **pin**, keyed by
`(tenantId, scanId)`. Retries read the pin back. Publishing a new policy, a sunset passing, or the
tenant changing its opt-ins does not change a pinned scan. `pin.fingerprint` is a SHA-256 over
everything above except the ids. Include it in result cache keys, next to the rule-pack fingerprint.

Two notes for reproducible re-runs:

- Pass `asOf` (for example, the commit date) so that two different scans of the same commit agree
  even if they run on different days. If you omit it, `asOf` is the UTC day the scan was first
  pinned.
- `planScan` sorts by code point (not locale), so the same pin and language map always give an
  identical plan regardless of input order.

The regression fixture `sunset-boundary-regression.json` freezes the decisions and fingerprints on
the day before, on, and after each boundary. A diff there means existing results would no longer
reproduce.

## Interface

### Operator

```ts
const service = new LanguageLifecycleService({
  store: new FileLanguageLifecycleStore("/var/lib/gasguard/language-lifecycle"),
  config: loadLanguageLifecycleConfigFromEnv(),
});

await service.publishPolicy(policy);                         // INVALID_POLICY | TRANSITION_REJECTED | CONFLICT
await service.publishPolicy(policy, { force: true, reason }); // audited override
await service.getPolicy();                                   // current, or built-in default (version 0.0.0)
await service.listPolicyHistory();                           // every published policy, oldest first
await service.checkCoverage(registry.getSupportedLanguages()); // policy vs analyzers
```

`publishPolicy` is idempotent: publishing the policy that is already current returns
`{ result: "unchanged" }` and writes nothing, so a timed-out publish can be retried safely.
`checkCoverage` reports `no_analyzer` when a non-retired language has no registered analyzer, which
would otherwise produce zero findings that look clean. It reports `unlisted_analyzer_language` when
an analyzer handles a language that the policy does not manage.

### Tenant

```ts
await service.setPreviewOptIns(tenantId, ["cairo"]);
await service.describeForTenant(tenantId, asOf?); // { policyVersion, asOf, languages: decisions, previewOptIns }
```

A tenant may opt into a language before it becomes `preview`. The opt-in takes effect only while
the language is `preview`. `describeForTenant` contains nothing about other tenants and is safe to
return from a tenant-scoped API.

### Worker

```ts
const { result, plan } = await runScanWithLanguagePolicy(
  service,
  { tenantId, scanId, languageMap, asOf: commitDate },
  (analyzable, plan) => registry.analyzeMultiple(files, analyzable),
);
// plan.status: complete | partial | unsupported | empty
// plan.skipped: [{ path, language, reason }]  plan.warnings: [{ language, files, sunsetAt, replacement, message }]
```

`languageMap` is the engine's path-to-language map. Files that are not in it are not source files,
and are ignored exactly as the registry ignores them. `detectLanguages(paths, policy)` builds one
from extensions: the match is case-insensitive, the longest claimed extension wins. A bare dotfile such as `.vy` is not
treated as an extension, and directory names never match. Callers then override ambiguous files (for example, Rust crates that
depend on `soroban-sdk`).

### Housekeeping

`purgeExpiredPins()` removes pins older than `pinRetentionMs`. Run it periodically. A retry that
arrives after its pin was purged is re-pinned under the decisions in force at that time.

## Configuration and backward compatibility

| Option | Env | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `LANGUAGE_LIFECYCLE_ENABLED` | `true` | Kill switch. `false` analyzes every language for new scans (`policy_disabled`). Existing pins are still honoured. |
| `minDeprecationNoticeDays` | `LANGUAGE_LIFECYCLE_MIN_NOTICE_DAYS` | `90` | Minimum deprecation window, both inside an entry and from the publish day. |
| `unlistedLanguageAction` | `LANGUAGE_LIFECYCLE_UNLISTED_ACTION` | `analyze` | What happens to files in languages the policy does not list: `analyze` (as before) or `skip` (`unlisted_language`). |
| `maxFilesPerScan` | `LANGUAGE_LIFECYCLE_MAX_FILES` | `100000` | Upper bound on files that `planScan` classifies. |
| `maxLanguages` | `LANGUAGE_LIFECYCLE_MAX_LANGUAGES` | `64` | Upper bound on policy entries and preview opt-ins. |
| `pinRetentionMs` | `LANGUAGE_LIFECYCLE_PIN_RETENTION_MS` | 7 days | Pin retention for `purgeExpiredPins`. |

Unset or blank variables keep their defaults. A variable that is set but malformed throws a
`RangeError` at startup.

The defaults are backward compatible:

- Until a policy is published, the built-in `DEFAULT_LANGUAGE_POLICY` (version `0.0.0`) marks every
  engine language `supported`.
- Unlisted languages are analyzed.
- The kill switch restores the pre-policy behaviour immediately.

## Failure semantics

Every error is a `LanguageLifecycleError` with a `code` and a `retryable` flag.

| Code | Retryable | When |
| --- | --- | --- |
| `INVALID_INPUT` | No | Bad tenant/scan id (empty, over 200 chars, or containing control characters), bad `asOf`, bad opt-ins, malformed `languageMap` (non-Map, empty/non-string language, empty/NUL/over-4096-char path), more than `maxFilesPerScan` files, or a forced publish without a reason |
| `INVALID_POLICY` | No | The policy fails validation; `violations` lists every problem |
| `TRANSITION_REJECTED` | No | Governance violation; `violations` lists codes and languages |
| `UNSUPPORTED_REPOSITORY` | No | The repository has source files, but none in an analyzable language. The worker throws this before running any analyzer, and the message names the languages found |
| `CONFLICT` | Yes | Another publish landed between read and write (optimistic concurrency on the policy digest) |
| `STORE_UNAVAILABLE` | Yes | Any storage failure. The store's own message is never surfaced or logged, because it may contain paths or credentials |

### Unsupported input and partial failure

- `partial` (some files skipped) still runs the scan. `plan.skipped` and `plan.warnings` travel with
  the result so that reports can show "N files in retired language X were not analyzed" instead of
  implying a clean result.
- `unsupported` fails the scan with a non-retryable error, because retrying the same commit and pin
  would fail the same way.
- `empty` (no recognised source) runs the scan with an empty map. This matches the registry's
  previous behaviour.

### Retries

- `STORE_UNAVAILABLE` from resolution happens before any analysis, so the queue's normal retry
  policy applies and nothing has been pinned.
- After a successful pin, a failed attempt can be retried freely. The retry reuses the pin, even
  across process restarts, policy publishes, and sunsets.
- If two attempts of the same scan race, the store's write-once pin decides. The loser reads and
  uses the winner's pin.

## Tenant isolation

- Opt-ins and pins are stored per tenant and always read with an explicit tenant id. The file store
  puts each tenant under `tenants/<sha256(tenantId)>/` and refuses records whose contents do not
  match their key.
- On-disk paths are SHA-256 digests of identifiers and never the identifiers themselves, so crafted
  ids cannot traverse directories.
- Colliding scan ids across tenants get independent pins.
- The policy itself is platform data and contains no tenant identifiers.

## Metrics and logs

Prometheus text from `service.metrics.toPrometheus(policy?, asOf?)`:

| Metric | Labels |
| --- | --- |
| `gasguard_language_pins_total` | `result` (created, reused) |
| `gasguard_language_plans_total` | `status` |
| `gasguard_language_files_skipped_total` | `language`, `reason` |
| `gasguard_language_deprecated_files_total` | `language` |
| `gasguard_language_policy_publishes_total` | `result` (published, unchanged, forced) |
| `gasguard_language_policy_violations_total` | `code` |
| `gasguard_language_lifecycle_errors_total` | `code` |
| `gasguard_language_stage` (gauge) | `language`, `stage` |

Labels come from closed sets plus policy-controlled language slugs. Tenant ids, scan ids,
repositories, and paths never become labels.

Logs are one JSON object per line with `component: "language-lifecycle"`:

- **Events:** `policy_published`, `preview_opt_ins_updated`, `scan_pinned`, `scan_pin_reused`,
  `scan_planned`, `plan_scan_failed`, `operation_failed`, `pins_purged`.
- **Fields:** identifiers, versions, digests, fingerprints, counts, and codes only.
- **Sanitization:** `sanitizeLogFields` drops any key matching
  payload/content/source/body/path/file/secret/token/password/key/credential/authorization. This
  applies to custom loggers too.

Actionable signals:

- **`deprecated_files_total` rising for a language:** these tenants need migration outreach before
  `sunsetAt`.
- **`files_skipped_total{reason="retired"}` after a sunset:** these tenants are now getting partial
  results.
- **`plans_total{status="unsupported"}`:** these scans failed outright.
- **`errors_total{code="STORE_UNAVAILABLE"}`:** storage health.

## Limitations

- `FileLanguageLifecycleStore` serializes writes within one process. Multi-process deployments on
  shared storage should implement `LanguageLifecycleStore` over a database that does the digest
  check in one conditional update.
- Detection by extension cannot separate languages that share one (`.rs` for rust and soroban).
  Callers must supply those languages in `languageMap`.
- No HTTP controller is included. The service methods map directly onto operator and tenant
  endpoints, behind the existing auth guards.

## Verification

```bash
npx jest apps/api/src/language-lifecycle
```

- **Unit tests:** config, policy validation and governance, detection, planning, stores (both
  implementations), metrics and log hygiene, and the service.
- **Integration tests:** the realistic Soroban DEX repository fixture runs end to end through the
  worker, the file store (with restarts), and the engine's real `AnalyzerRegistry`.
- **Regression tests:** frozen sunset-boundary decisions and fingerprints.
