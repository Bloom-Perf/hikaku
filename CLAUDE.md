# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                # Run all tests with mocha (TypeScript loaded through tsx)
npm run test:coverage   # Run tests with coverage via c8
npm run typecheck       # Type-check src and test (no emit)
npm run build           # Bundle with esbuild, then emit the declarations into dist/
npm run format:check    # Prettier check of src and test (CI runs it)
```

To run a single test file: `npx mocha test/compare.spec.ts` (`.mocharc.json` lists every spec, so all of them run anyway).

Relative imports use explicit `.js` extensions (`moduleResolution: nodenext`), e.g. `import { compare } from './compare.js'`. Node.js 22 or later.

## Architecture

Hikaku detects performance regressions between two runs of [Kyara](https://github.com/Bloom-Perf/kyara), its main consumer: Kyara calls it in "hikaku mode" (`KYARA_HIKAKU_BASELINE_PATH`).

```
Prometheus registry → createSnapshot() → RunSnapshot → saveBaseline() / loadBaseline()
                                              ↓
                              compare(current, baseline) → ComparisonReport → generateReport() (LLM)
```

- `src/snapshot.ts` - Reads a `MetricsSource` (anything with `getMetricsAsJSON()`: `@prometheus-io/client`, `prom-client` 15) and computes percentiles with the Prometheus `histogram_quantile` interpolation. It knows Kyara's metric names: `browser_request*` and `browser_request_duration_seconds` labelled `hostname`, `scenario`, `iteration`; `dsd_{tab,pod}_{cpu_percent,ram_kb}` labelled `browser`. A percentile without samples is `NaN` (`null` once saved).
- `src/compare.ts` - Matches scenario iterations by `"scenario:iteration"` and browsers by name. Fails on latency, error rate or resource regressions, and when baseline iterations are missing; values that are not finite are not compared.
- `src/baseline.ts` - Versioned JSON file (`version: 1`). Changing the snapshot shape in an incompatible way means a new version and a migration in `loadBaseline`.
- `src/report.ts` - Prompt construction and `createAnthropicProvider` (dynamic import of the optional peer dependency `@anthropic-ai/sdk`, streamed request). Tests run it against a local server through `ANTHROPIC_BASE_URL`.
- `src/types.ts` - Public types; `src/index.ts` is the only entry point (`exports` in package.json).

No runtime dependency: the Prometheus client is whatever Kyara uses, the Anthropic SDK is optional.

## Changing the metrics

Kyara's `src/metrics.ts` defines the metrics: keep names, labels and units in sync with it (its tests build a snapshot with the real hikaku).

## Releases

Bump the version in a PR (`npm version <x.y.z> --no-git-tag-version`), merge, then publish a GitHub release `v<x.y.z>`: `.github/workflows/publish.yml` publishes to npm with Trusted Publishing (OIDC, no token).
