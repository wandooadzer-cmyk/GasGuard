# CLI Flag Deprecation System

This module provides a comprehensive deprecation warning system for GasGuard CLI flags, enabling graceful migration paths for users while maintaining backward compatibility.

## Features

- ✅ **Automatic Detection**: Scans command-line arguments for deprecated flags
- ✅ **Severity Levels**: HIGH, MEDIUM, and LOW severity classifications
- ✅ **Colored Warnings**: User-friendly console output with actionable guidance
- ✅ **Structured Logging**: JSON logs to stderr for operational visibility
- ✅ **Metrics Tracking**: Aggregated usage patterns across invocations
- ✅ **Configurable Behavior**: Environment variable overrides
- ✅ **Commander.js Integration**: Seamless hooks into CLI lifecycle

## Architecture

```
deprecation/
├── types.ts          # TypeScript type definitions
├── config.ts         # Deprecated flags registry and configuration
├── detector.ts       # Core detection and warning logic
├── logger.ts         # Structured logging for operations
├── metrics.ts        # Usage metrics collection
├── integration.ts    # Commander.js integration utilities
└── index.ts         # Main entry point and orchestration
```

## Usage

### Basic Usage

```typescript
import { checkDeprecatedFlags } from './deprecation';

// Check argv for deprecated flags
const result = checkDeprecatedFlags(process.argv);

if (result.hasHighSeverity) {
  console.error('High-severity deprecated flags detected!');
}
```

### Commander.js Integration

```typescript
import { Command } from 'commander';
import { attachDeprecationHook } from './deprecation/integration';

const program = new Command();
attachDeprecationHook(program);

// Deprecation checking now happens automatically before each command
```

### Adding a Deprecated Flag

Edit `config.ts` and add a new entry to `DEPRECATED_FLAGS`:

```typescript
{
  flag: "--old-flag",
  replacement: "--new-flag",
  message: "The '--old-flag' is deprecated. Use '--new-flag' instead.",
  severity: DeprecationSeverity.HIGH,
  deprecatedIn: "1.2.0",
  removedIn: "2.0.0",
  documentationUrl: "https://docs.gasguard.io/migration/old-to-new",
}
```

## Configuration

### Environment Variables

- `GASGUARD_DEPRECATION_WARNINGS=false` - Disable warning output
- `GASGUARD_DEPRECATION_METRICS=false` - Disable metrics tracking
- `GASGUARD_FAIL_ON_DEPRECATED=true` - Exit on high-severity deprecations

### Programmatic Configuration

```typescript
import { loadDeprecationConfig } from './deprecation';

const config = loadDeprecationConfig();
config.enableWarnings = false;
```

## Severity Levels

### HIGH
- Flag will be removed in the next major version
- Breaks existing workflows if not addressed
- **Color**: Red

### MEDIUM
- Flag will be removed in a future version
- Users should plan migration
- **Color**: Yellow

### LOW
- Soft-deprecated, no immediate removal planned
- Informational only
- **Color**: Blue

## Output Examples

### Console Warning

```
⚠️  Deprecation Warning [HIGH]
   The '--analyze-local' flag is deprecated. Use the 'scan' command instead.
   → Use: scan
   ⏰ Will be removed in version 2.0.0
   📖 https://docs.gasguard.io/migration/analyze-local-to-scan
```

### Structured Log

```json
{
  "timestamp": "2024-02-20T10:30:45.123Z",
  "component": "cli.deprecation",
  "level": "warn",
  "event": "cli.deprecation.detected",
  "correlationId": "dep_a1b2c3d4",
  "message": "Deprecated flag detected: --analyze-local",
  "flag": "--analyze-local",
  "severity": "high",
  "replacement": "scan",
  "position": 2
}
```

## Metrics

The system tracks aggregated metrics across invocations:

```typescript
import { getMetricsCollector } from './deprecation';

const collector = getMetricsCollector();
const metrics = collector.getMetrics();

console.log(metrics);
// {
//   totalUsages: 42,
//   byFlag: { "--old-flag": 42 },
//   bySeverity: { high: 42, medium: 0, low: 0 },
//   firstSeen: "2024-02-20T10:00:00.000Z",
//   lastSeen: "2024-02-20T11:00:00.000Z",
//   invocationCount: 15
// }
```

## Testing

The system is fully testable with dependency injection:

```typescript
import { DeprecationDetector, DeprecationConfig } from './deprecation';

const config: DeprecationConfig = { /* test config */ };
const detector = new DeprecationDetector(config);
const result = detector.analyze(['--old-flag']);

expect(result.usages.length).toBe(1);
```

## Migration Guide

When deprecating a flag:

1. **Add entry to `DEPRECATED_FLAGS`** with appropriate severity
2. **Set `deprecatedIn` version** to current release
3. **Set `removedIn` version** to planned removal (usually next major)
4. **Create migration documentation** and link it
5. **Update tests** to cover the deprecation
6. **Announce in release notes** and changelog
7. **Monitor metrics** to track adoption

## Tenant Isolation

The deprecation system is stateless and thread-safe:

- No shared mutable state between invocations
- Metrics are aggregated but don't affect behavior
- Each invocation gets a unique correlation ID
- Concurrent CLI executions cannot interfere

## Security Considerations

- **No PII**: Deprecation logs exclude user data and file paths
- **No secrets**: Only flag names and positions are logged
- **Safe defaults**: Warnings are informational, not blocking by default
- **Predictable**: Detection is deterministic and reproducible

## Performance

- **Minimal overhead**: Parsing argv is O(n) where n = argument count
- **Non-blocking**: Warnings and logs don't delay execution
- **Async-safe**: All operations are synchronous and deterministic
- **Memory efficient**: No large data structures, immediate output

## Backward Compatibility

This system maintains full backward compatibility:

- Deprecated flags continue to work as before
- Users opt into strict mode via environment variable
- Warnings go to stderr, don't interfere with stdout
- No breaking changes to command behavior
