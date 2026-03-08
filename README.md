# Hikaku 比較

[![npm version](https://img.shields.io/npm/v/@bloom-perf/hikaku?style=flat&logo=npm)](https://www.npmjs.com/package/@bloom-perf/hikaku)
[![GitHub last commit](https://img.shields.io/github/last-commit/bloom-perf/hikaku?logo=github)](https://github.com/bloom-perf/hikaku)
[![GitHub release](https://img.shields.io/github/v/release/bloom-perf/hikaku?style=flat)](https://github.com/Bloom-Perf/hikaku/releases)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat)](https://opensource.org/licenses/Apache-2.0)

**Hikaku** (比較, "comparison" in Japanese) is a lightweight, zero-dependency metrics analysis library for [Kyara](https://github.com/Bloom-Perf/kyara) load testing. It reads Prometheus metrics directly from the [prom-client](https://github.com/siimon/prom-client) registry, computes structured snapshots, and detects performance regressions by comparing against JSON baselines.

## Table of Contents

- [Why Hikaku?](#why-hikaku)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Baseline Format](#baseline-format)
- [Thresholds Configuration](#thresholds-configuration)
- [Design Decisions](#design-decisions)
- [Contributing](#contributing)
- [License](#license)

## Why Hikaku?

Kyara generates detailed Prometheus metrics during load tests — HTTP request counts, latency histograms, error rates, CPU/RAM consumption — all labelled by `scenario` and `iteration`. The challenge is: **how do you detect regressions between test runs?**

### Why not use Prometheus directly?

Prometheus excels at monitoring continuously running services, but it has fundamental limitations for discrete load test comparison:

| Limitation | Impact |
|---|---|
| **No concept of "test run"** | Prometheus sees a continuous time series, not isolated runs. Comparing run A vs run B requires knowing exact timestamps, managed externally. |
| **Continuous-service assumption** | Functions like `avg_over_time` and `stddev_over_time` assume a steady stream of data. Load tests produce isolated bursts separated by long silences — rolling averages become meaningless. |
| **Cardinality explosion** | Adding a `run_id` label to distinguish runs creates unbounded label values — a well-known Prometheus anti-pattern that causes memory growth and potential OOM. |
| **Ephemeral environments** | In CI pipelines, the Prometheus instance may not persist between runs, making historical comparisons impossible. |
| **Expensive subqueries** | Computing `histogram_quantile` inside a subquery (for comparison over time) is costly and has alignment pitfalls flagged by Prometheus maintainers. |

### Why not use Keptn / Iter8?

Existing tools like Keptn (quality gates) and Iter8 (SLO validation) require Kubernetes operators, Helm charts, and significant infrastructure. They are designed for production deployment pipelines, not lightweight CI load test checks.

### Hikaku's approach

Hikaku takes a different path: **read metrics in-memory, compare against a file**.

- **Zero infrastructure** — no Prometheus server, no Kubernetes, no operator
- **In-process** — reads directly from `prom-client`'s `Registry`, no HTTP scraping
- **File-based baselines** — a JSON snapshot stored in git or as a CI artifact
- **Run-to-run semantics** — each baseline is a discrete snapshot, no timestamp bookkeeping
- **Same math as Prometheus** — percentiles use identical linear interpolation (`histogram_quantile`)

## How It Works

```
                          Kyara load test run
                                  │
                                  ▼
                     prom-client Registry (in-memory)
                                  │
                        createSnapshot(registry)
                                  │
                                  ▼
                           ┌─────────────┐
                           │ RunSnapshot  │──── saveBaseline() ──▶ baseline.json
                           └─────────────┘                            │
                                  │                                   │
                                  │         loadBaseline() ◀──────────┘
                                  │              │
                                  ▼              ▼
                         compare(current, baseline, thresholds)
                                  │
                                  ▼
                        ┌──────────────────┐
                        │ ComparisonReport │
                        │   verdict: pass  │
                        │   or fail        │
                        └──────────────────┘
```

1. **Snapshot** — At the end of a Kyara run, `createSnapshot()` reads all metrics and produces a `RunSnapshot` structured by scenario, iteration, and hostname
2. **Baseline** — The first run's snapshot is saved as a baseline JSON file via `saveBaseline()`
3. **Compare** — Subsequent runs compare their snapshot against the baseline via `compare()`, producing a `ComparisonReport` with per-scenario deltas and a pass/fail verdict

## Installation

```bash
npm install @bloom-perf/hikaku
```

`prom-client` is a **peer dependency** — it must be installed separately (Kyara already includes it).

## Quick Start

```typescript
import { createSnapshot, saveBaseline, loadBaseline, baselineExists, compare } from '@bloom-perf/hikaku';
import { Registry } from 'prom-client';

// After your Kyara load test completes...
const registry: Registry = getYourPromRegistry();

// Take a snapshot of current metrics
const snapshot = await createSnapshot(registry);

const baselinePath = './baseline.json';

if (!baselineExists(baselinePath)) {
  // First run: save as baseline
  saveBaseline(snapshot, baselinePath);
  console.log('Baseline saved.');
} else {
  // Subsequent runs: compare against baseline
  const baseline = loadBaseline(baselinePath);
  const report = compare(snapshot, baseline);

  console.log(`Verdict: ${report.overallVerdict}`);
  console.log(`Scenarios: ${report.summary.passed} passed, ${report.summary.failed} failed`);

  if (report.overallVerdict === 'fail') {
    for (const regression of report.summary.regressions) {
      console.log(`  ⚠ ${regression.metricName}: ${regression.deltaPercent.toFixed(1)}% increase`);
    }
    process.exit(1);
  }
}
```

## API Reference

### `createSnapshot(registry): Promise<RunSnapshot>`

Reads all metrics from a `prom-client` Registry and produces a structured `RunSnapshot`.

- Extracts counters grouped by `(scenario, iteration, hostname)`
- Computes p50/p75/p90/p95/p99 percentiles from histogram buckets
- Groups resource metrics (CPU, RAM) by browser

### `saveBaseline(snapshot, filePath): void`

Saves a `RunSnapshot` as a versioned JSON baseline file.

### `loadBaseline(filePath): Baseline`

Loads and validates a baseline file. Throws on missing file or unsupported version.

### `baselineExists(filePath): boolean`

Returns `true` if a baseline file exists at the given path.

### `compare(current, baseline, thresholds?): ComparisonReport`

Compares a current `RunSnapshot` against a `Baseline` and returns a detailed report.

**Matching:** Scenarios are matched by composite key `"scenario:iteration"`.

**Metrics compared:**
- `p95_latency` — 95th percentile of request duration (aggregated across hosts)
- `p50_latency` — 50th percentile of request duration
- `error_rate` — ratio of failed requests to total requests

**Verdicts:**
- A scenario **fails** if `p95_latency` or `p50_latency` increases beyond the threshold, or if `error_rate` increases beyond its threshold
- The overall verdict is **fail** if any scenario fails
- New scenarios (present in current but absent from baseline) are **skipped**

### `histogramQuantile(quantile, buckets): number`

Low-level utility: computes a quantile from histogram buckets using linear interpolation, matching the Prometheus `histogram_quantile()` algorithm.

## Baseline Format

Baselines are human-readable JSON files, suitable for version control:

```json
{
  "version": 1,
  "createdAt": "2026-03-08T15:00:00.000Z",
  "snapshot": {
    "timestamp": "2026-03-08T15:00:00.000Z",
    "scenarios": [
      {
        "scenario": "Login",
        "iteration": 0,
        "hosts": [
          {
            "hostname": "api.example.com",
            "requestCount": 150,
            "requestFinishedCount": 148,
            "requestFailedCount": 2,
            "responseCount": 148,
            "durationPercentiles": { "p50": 0.12, "p75": 0.25, "p90": 0.45, "p95": 0.62, "p99": 1.1 },
            "durationSum": 28.5,
            "durationCount": 150
          }
        ],
        "totalRequests": 150,
        "totalRequestsFailed": 2,
        "errorRate": 0.0133,
        "aggregatedDurationPercentiles": { "p50": 0.12, "p75": 0.25, "p90": 0.45, "p95": 0.62, "p99": 1.1 }
      }
    ],
    "resources": []
  }
}
```

## Thresholds Configuration

Default thresholds:

| Parameter | Default | Description |
|---|---|---|
| `defaultMaxIncreasePercent` | `20` | Max allowed percentage increase for p50/p95 latency |
| `defaultMaxErrorRateIncreasePercent` | `10` | Max allowed percentage increase for error rate |

Custom thresholds:

```typescript
const report = compare(snapshot, baseline, {
  defaultMaxIncreasePercent: 15,        // Stricter: 15% max
  defaultMaxErrorRateIncreasePercent: 5, // Very strict on errors
  perScenario: {
    'Checkout:0': { maxIncreasePercent: 30 },  // More tolerant for checkout
    'Login:0': { maxErrorRateIncreasePercent: 0 }, // Zero tolerance on login errors
  },
});
```

Per-scenario overrides use the key format `"scenarioName:iteration"`.

## Design Decisions

| Decision | Rationale |
|---|---|
| **prom-client as peer dependency** | Hikaku reads the registry in-memory — it must share the same instance as Kyara. No runtime dependencies. |
| **JSON baselines** | Human-readable, diffable in git, portable as CI artifacts. The `version` field enables future format evolution. |
| **Same `histogram_quantile` algorithm** | Percentiles computed from bucket boundaries using linear interpolation, identical to Prometheus. Results are directly comparable to Grafana dashboards. |
| **Match by `scenario:iteration`** | Leverages the labels added to Kyara's metrics in v2.0.0, enabling per-scenario regression detection without high-cardinality `run_id` labels. |
| **Stateless comparison** | No database, no time-series storage. Each comparison is a pure function: `(current, baseline) → report`. |

## Bloom-Perf Ecosystem

Hikaku is part of the [Bloom-Perf](https://github.com/Bloom-Perf) load testing ecosystem:

| Package | Role |
|---|---|
| [**kyara**](https://github.com/Bloom-Perf/kyara) | Load testing engine — Puppeteer + Firefox + YAML scenarios + Prometheus metrics |
| [**yaml-pptr**](https://github.com/Bloom-Perf/yaml-pptr) | YAML-to-Puppeteer scenario interpreter |
| [**hikaku**](https://github.com/Bloom-Perf/hikaku) | Metrics analysis and regression detection |

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Format code
npm run format
```

## License

Hikaku is licensed under the [Apache 2.0 License](https://opensource.org/licenses/Apache-2.0).
