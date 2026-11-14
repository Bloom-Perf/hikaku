# Hikaku 比較

[![npm version](https://img.shields.io/npm/v/@bloom-perf/hikaku?style=flat&logo=npm)](https://www.npmjs.com/package/@bloom-perf/hikaku)
[![GitHub last commit](https://img.shields.io/github/last-commit/bloom-perf/hikaku?logo=github)](https://github.com/bloom-perf/hikaku)
[![GitHub release](https://img.shields.io/github/v/release/bloom-perf/hikaku?style=flat)](https://github.com/Bloom-Perf/hikaku/releases)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat)](https://opensource.org/licenses/Apache-2.0)

**Hikaku** (比較, "comparison" in Japanese) is a lightweight metrics analysis library for [Kyara](https://github.com/Bloom-Perf/kyara) load testing. It reads Prometheus metrics directly from the [`@prometheus-io/client`](https://www.npmjs.com/package/@prometheus-io/client) registry (formerly `prom-client`), computes structured snapshots, detects performance regressions by comparing against JSON baselines, and optionally generates **natural language reports via LLM**.

## Table of Contents

- [Why Hikaku?](#why-hikaku)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Baseline Format](#baseline-format)
- [Thresholds Configuration](#thresholds-configuration)
- [LLM Reporting](#llm-reporting)
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
- **In-process** — reads directly from the Prometheus client's `Registry`, no HTTP scraping
- **File-based baselines** — a JSON snapshot stored in git or as a CI artifact
- **Run-to-run semantics** — each baseline is a discrete snapshot, no timestamp bookkeeping
- **Same math as Prometheus** — percentiles use identical linear interpolation (`histogram_quantile`)

## How It Works

```
                          Kyara load test run
                                  │
                                  ▼
                  Prometheus Registry (in-memory)
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
                                  │
                        generateReport(report, ...)
                                  │
                                  ▼
                        ┌──────────────────┐
                        │  LLM Report      │
                        │  (optional)      │
                        └──────────────────┘
```

1. **Snapshot** — At the end of a Kyara run, `createSnapshot()` reads all metrics and produces a `RunSnapshot` structured by scenario, iteration, and hostname
2. **Baseline** — The first run's snapshot is saved as a baseline JSON file via `saveBaseline()`
3. **Compare** — Subsequent runs compare their snapshot against the baseline via `compare()`, producing a `ComparisonReport` with per-scenario deltas and a pass/fail verdict

## Installation

```bash
npm install @bloom-perf/hikaku
```

Hikaku has no runtime dependency. It reads any registry with a `getMetricsAsJSON()` method: [`@prometheus-io/client`](https://www.npmjs.com/package/@prometheus-io/client), or `prom-client` 15 (its former name, deprecated). Requires Node.js 22 or later.

## Quick Start

```typescript
import { createSnapshot, saveBaseline, loadBaseline, baselineExists, compare } from '@bloom-perf/hikaku';
import { Registry } from '@prometheus-io/client';

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
    for (const r of report.summary.regressions) {
      const where = r.browser ?? `${r.scenario} #${r.iteration}`;
      console.log(`  ⚠ ${where}: ${r.metricName} +${r.deltaPercent.toFixed(1)}%`);
    }
    for (const m of report.summary.missingScenarios) {
      console.log(`  ⚠ ${m.scenario} #${m.iteration} did not run`);
    }
    process.exit(1);
  }
}
```

## API Reference

### `createSnapshot(registry): Promise<RunSnapshot>`

Reads all metrics from a registry (`@prometheus-io/client`, `prom-client` 15, or any `MetricsSource`: an object with `getMetricsAsJSON()`) and produces a structured `RunSnapshot`.

- Extracts counters grouped by `(scenario, iteration, hostname)`
- Computes p50/p75/p90/p95/p99 percentiles from histogram buckets
- Groups resource metrics (CPU, RAM) by browser (`dsd_tab_*` per tab, `dsd_pod_*` for the whole browser): percentiles and exact means. A value without any sample is `NaN` (`null` once saved)

### `saveBaseline(snapshot, filePath): void`

Saves a `RunSnapshot` as a versioned JSON baseline file, creating its directory if needed.

### `loadBaseline(filePath): Baseline`

Loads and validates a baseline file. Throws, naming the file, when it is missing, is not JSON, is not a baseline or has an unsupported version.

### `baselineExists(filePath): boolean`

Returns `true` if a baseline file exists at the given path.

### `compare(current, baseline, thresholds?): ComparisonReport`

Compares a current `RunSnapshot` against a `Baseline` and returns a detailed report.

**Matching:** Scenarios are matched by composite key `"scenario:iteration"`, browsers by name.

**Metrics compared, per scenario iteration** (`report.scenarios`):
- `p95_latency` — 95th percentile of request duration (aggregated across hosts)
- `p50_latency` — 50th percentile of request duration
- `error_rate` — ratio of failed requests to total requests
- `total_requests` — informational, never fails

**Metrics compared, per browser** (`report.resources`), when both runs measured it:
- `mean_browser_cpu_percent`, `mean_browser_ram_kb` — the whole browser (all its processes)
- `mean_tab_cpu_percent`, `mean_tab_ram_kb` — each process rendering pages

These are the exact means of the samples (histogram sum / count). The percentiles of the snapshot are interpolated within the buckets, as coarse as them (e.g. 100, 150, 200 % of CPU): between two runs consuming the same, a p95 can jump to the next bucket, so they are not compared.

A value the baseline or the current run does not know (no sample) is not compared.

**Verdicts:**
- A scenario iteration **fails** if `p95_latency` or `p50_latency` increases beyond the threshold, or if `error_rate` increases beyond its threshold
- A browser **fails** if one of its metrics increases beyond `defaultMaxResourceIncreasePercent`
- The overall verdict is **fail** if a scenario iteration or a browser fails, or if scenario iterations of the baseline did not run (`summary.missingScenarios`): the runs are not comparable, update the baseline if the scenarios changed
- New scenario iterations (`summary.newScenarios`) and browsers no longer measured (`summary.missingBrowsers`, e.g. a run on macOS, where Kyara does not measure the browsers) are listed, not compared
- `summary.regressions` lists every regression with its `scenario` and `iteration`, or its `browser`

### `generateReport(report, current, baseline, options): Promise<string>`

Generates a natural language performance report from a `ComparisonReport` using an LLM provider.

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `provider` | `LlmProvider` | *(required)* | LLM backend to use |
| `locale` | `'en' \| 'fr'` | `'en'` | Report language |
| `format` | `'markdown' \| 'text'` | `'markdown'` | Output format |
| `includeRecommendations` | `boolean` | `true` | Include investigation suggestions |

### `createAnthropicProvider(apiKey, model?): LlmProvider`

Creates an LLM provider using the Anthropic SDK. Requires `@anthropic-ai/sdk` as a peer dependency.

- `apiKey` — Anthropic API key
- `model` — Model name (default: `DEFAULT_ANTHROPIC_MODEL`, `claude-sonnet-5-5`)

The message is streamed (the snapshots can make a long input), with up to 16,000 output tokens: the model may think before writing. The provider rejects when the model declines or returns no text. The SDK reads `ANTHROPIC_BASE_URL` to reach a proxy or a gateway.

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
| `defaultMaxErrorRateIncreasePercent` | `10` | Max allowed percentage increase for error rate (relative: 1% → 1.1% is +10%; from 0, any error fails) |
| `defaultMaxResourceIncreasePercent` | `20` | Max allowed percentage increase for the mean CPU and memory of each browser |

Custom thresholds:

```typescript
const report = compare(snapshot, baseline, {
  defaultMaxIncreasePercent: 15,        // Stricter: 15% max
  defaultMaxErrorRateIncreasePercent: 5, // Very strict on errors
  defaultMaxResourceIncreasePercent: 30, // CPU and memory of the browsers
  perScenario: {
    Checkout: { maxIncreasePercent: 30 },  // More tolerant for all checkout iterations
    'Login:0': { maxErrorRateIncreasePercent: 0 }, // Zero tolerance on the first login
  },
});
```

Per-scenario overrides use the key `"scenarioName"` (all its iterations) or `"scenarioName:iteration"` (one iteration, wins over the former).

## LLM Reporting

Hikaku can generate human-readable performance reports using an LLM. This is optional and requires `@anthropic-ai/sdk` as a peer dependency (or a custom `LlmProvider`).

```bash
npm install @anthropic-ai/sdk
```

### Using the built-in Anthropic provider

```typescript
import { compare, generateReport, createAnthropicProvider } from '@bloom-perf/hikaku';

const report = compare(snapshot, baseline);

if (report.overallVerdict === 'fail') {
  const provider = createAnthropicProvider(process.env.ANTHROPIC_API_KEY!);
  const analysis = await generateReport(report, snapshot, baseline, {
    provider,
    locale: 'fr',
    format: 'markdown',
  });
  console.log(analysis);
}
```

### Using a custom LLM provider

Implement the `LlmProvider` interface to use any LLM backend:

```typescript
import type { LlmProvider } from '@bloom-perf/hikaku';

const myProvider: LlmProvider = {
  async complete(systemPrompt, userMessage) {
    // Call your preferred LLM API here
    return await myLlmClient.chat(systemPrompt, userMessage);
  },
};

const analysis = await generateReport(report, snapshot, baseline, { provider: myProvider });
```

## Design Decisions

| Decision | Rationale |
|---|---|
| **No dependency on a Prometheus client** | Hikaku reads the registry in-memory, through its `getMetricsAsJSON()`: it works with the instance Kyara already has, whichever client version it uses. No runtime dependencies. |
| **JSON baselines** | Human-readable, diffable in git, portable as CI artifacts. The `version` field enables future format evolution. |
| **Same `histogram_quantile` algorithm** | Percentiles computed from bucket boundaries using linear interpolation, identical to Prometheus. Results are directly comparable to Grafana dashboards. |
| **Match by `scenario:iteration`** | Leverages the labels added to Kyara's metrics in v2.0.0, enabling per-scenario regression detection without high-cardinality `run_id` labels. |
| **Stateless comparison** | No database, no time-series storage. Each comparison is a pure function: `(current, baseline) → report`. |
| **Injectable LLM provider** | `LlmProvider` interface allows using any LLM backend. Anthropic SDK provided as a convenience, but not a hard dependency (optional peer dep + dynamic import). |
| **LLM only on demand** | Report generation is opt-in: no API calls unless explicitly requested. Keeps the core library fast and free. |

## Bloom-Perf Ecosystem

Hikaku is part of the [Bloom-Perf](https://github.com/Bloom-Perf) load testing ecosystem:

| Package | Role |
|---|---|
| [**kyara**](https://github.com/Bloom-Perf/kyara) | Load testing engine — Puppeteer + Chrome and Firefox + YAML scenarios + Prometheus metrics |
| [**yaml-pptr**](https://github.com/Bloom-Perf/yaml-pptr) | YAML-to-Puppeteer scenario interpreter |
| [**hikaku**](https://github.com/Bloom-Perf/hikaku) | Metrics analysis and regression detection |

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

Requires Node.js 22 or later.

```bash
npm install          # install dependencies
npm test             # run the tests (mocha, TypeScript loaded through tsx)
npm run typecheck    # type-check src and test
npm run build        # bundle with esbuild and emit the declarations into dist/
npm run format       # format with Prettier (CI runs npm run format:check)
```

## License

Hikaku is licensed under the [Apache 2.0 License](https://opensource.org/licenses/Apache-2.0).
