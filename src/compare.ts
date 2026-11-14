import type {
  RunSnapshot,
  Baseline,
  ComparisonReport,
  ComparisonThresholds,
  ScenarioComparison,
  ResourceComparison,
  ResourceMetrics,
  MetricDelta,
  MetricStatus,
  Regression,
  ScenarioKey,
  ScenarioMetrics,
} from "./types.js";
import { DEFAULT_THRESHOLDS } from "./types.js";

/**
 * Compare a current RunSnapshot against a Baseline.
 * Returns a ComparisonReport with per-scenario and per-browser verdicts and an overall verdict.
 *
 * The overall verdict is "fail" when a scenario iteration or a browser regressed, or when
 * scenario iterations of the baseline are missing from the current run (the runs are not
 * comparable: update the baseline if the scenarios changed).
 */
export function compare(
  current: RunSnapshot,
  baseline: Baseline,
  thresholds?: Partial<ComparisonThresholds>,
): ComparisonReport {
  const mergedThresholds: ComparisonThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...thresholds,
  };

  const baselineMap = new Map<string, ScenarioMetrics>();
  for (const s of baseline.snapshot.scenarios) {
    baselineMap.set(makeKey(s.scenario, s.iteration), s);
  }
  const currentKeys = new Set(
    current.scenarios.map((s) => makeKey(s.scenario, s.iteration)),
  );

  const scenarioComparisons: ScenarioComparison[] = [];
  const regressions: Regression[] = [];
  const newScenarios: ScenarioKey[] = [];

  for (const currentScenario of current.scenarios) {
    const { scenario, iteration } = currentScenario;
    const baselineScenario = baselineMap.get(makeKey(scenario, iteration));
    if (!baselineScenario) {
      newScenarios.push({ scenario, iteration });
      continue;
    }

    const comparison = compareScenario(
      currentScenario,
      baselineScenario,
      getThresholdsForScenario(scenario, iteration, mergedThresholds),
    );
    scenarioComparisons.push(comparison);
    for (const delta of comparison.deltas) {
      if (delta.status === "regression") {
        regressions.push({ ...delta, scenario, iteration });
      }
    }
  }

  const missingScenarios: ScenarioKey[] = baseline.snapshot.scenarios
    .filter((s) => !currentKeys.has(makeKey(s.scenario, s.iteration)))
    .map(({ scenario, iteration }) => ({ scenario, iteration }));

  const { resources, missingBrowsers } = compareResources(
    current.resources ?? [],
    baseline.snapshot.resources ?? [],
    mergedThresholds.defaultMaxResourceIncreasePercent,
  );
  for (const resource of resources) {
    for (const delta of resource.deltas) {
      if (delta.status === "regression") {
        regressions.push({ ...delta, browser: resource.browser });
      }
    }
  }

  const passed = scenarioComparisons.filter((s) => s.verdict === "pass").length;
  const failed = scenarioComparisons.filter((s) => s.verdict === "fail").length;
  const fail =
    failed > 0 ||
    resources.some((r) => r.verdict === "fail") ||
    missingScenarios.length > 0;

  return {
    timestamp: new Date().toISOString(),
    overallVerdict: fail ? "fail" : "pass",
    scenarios: scenarioComparisons,
    resources,
    summary: {
      totalScenarios: scenarioComparisons.length,
      passed,
      failed,
      regressions,
      missingScenarios,
      newScenarios,
      missingBrowsers,
    },
  };
}

// ============ Internal ============

function makeKey(scenario: string, iteration: number): string {
  return `${scenario}:${iteration}`;
}

type ScenarioThresholds = {
  maxIncreasePercent: number;
  maxErrorRateIncreasePercent: number;
};

function getThresholdsForScenario(
  scenario: string,
  iteration: number,
  thresholds: ComparisonThresholds,
): ScenarioThresholds {
  const forIteration =
    thresholds.perScenario?.[makeKey(scenario, iteration)] ?? {};
  const forScenario = thresholds.perScenario?.[scenario] ?? {};
  return {
    maxIncreasePercent:
      forIteration.maxIncreasePercent ??
      forScenario.maxIncreasePercent ??
      thresholds.defaultMaxIncreasePercent,
    maxErrorRateIncreasePercent:
      forIteration.maxErrorRateIncreasePercent ??
      forScenario.maxErrorRateIncreasePercent ??
      thresholds.defaultMaxErrorRateIncreasePercent,
  };
}

function computeDeltaPercent(
  baselineValue: number,
  currentValue: number,
): number {
  if (baselineValue === 0) return currentValue === 0 ? 0 : Infinity;
  return ((currentValue - baselineValue) / baselineValue) * 100;
}

function evaluateStatus(
  deltaPercent: number,
  maxIncreasePercent: number,
): MetricStatus {
  if (deltaPercent > maxIncreasePercent) return "regression";
  if (deltaPercent < -maxIncreasePercent) return "improvement";
  return "ok";
}

/**
 * The delta of one metric, or undefined when a value is unknown: NaN in a snapshot, null
 * once saved in a baseline (e.g. a resource metric without any sample for a browser).
 */
function computeDelta(
  metricName: string,
  baselineValue: number | null | undefined,
  currentValue: number | null | undefined,
  maxIncreasePercent: number | undefined,
): MetricDelta | undefined {
  if (!Number.isFinite(baselineValue) || !Number.isFinite(currentValue)) {
    return undefined;
  }
  const deltaPercent = computeDeltaPercent(baselineValue!, currentValue!);
  return {
    metricName,
    baselineValue: baselineValue!,
    currentValue: currentValue!,
    deltaPercent,
    // Informational metrics (no threshold) never fail
    status:
      maxIncreasePercent === undefined
        ? "ok"
        : evaluateStatus(deltaPercent, maxIncreasePercent),
  };
}

function compareScenario(
  current: ScenarioMetrics,
  baseline: ScenarioMetrics,
  { maxIncreasePercent, maxErrorRateIncreasePercent }: ScenarioThresholds,
): ScenarioComparison {
  const deltas = [
    computeDelta(
      "p95_latency",
      baseline.aggregatedDurationPercentiles.p95,
      current.aggregatedDurationPercentiles.p95,
      maxIncreasePercent,
    ),
    computeDelta(
      "p50_latency",
      baseline.aggregatedDurationPercentiles.p50,
      current.aggregatedDurationPercentiles.p50,
      maxIncreasePercent,
    ),
    computeDelta(
      "error_rate",
      baseline.errorRate,
      current.errorRate,
      maxErrorRateIncreasePercent,
    ),
    computeDelta(
      "total_requests",
      baseline.totalRequests,
      current.totalRequests,
      undefined,
    ),
  ].filter((d): d is MetricDelta => d !== undefined);

  return {
    scenario: current.scenario,
    iteration: current.iteration,
    deltas,
    verdict: deltas.some((d) => d.status === "regression") ? "fail" : "pass",
  };
}

/** Compares the p95 CPU and memory of each browser measured in both runs */
function compareResources(
  current: ResourceMetrics[],
  baseline: ResourceMetrics[],
  maxIncreasePercent: number,
): { resources: ResourceComparison[]; missingBrowsers: string[] } {
  const currentByBrowser = new Map(current.map((r) => [r.browser, r]));
  const resources: ResourceComparison[] = [];
  const missingBrowsers: string[] = [];

  for (const base of baseline) {
    const cur = currentByBrowser.get(base.browser);
    if (!cur) {
      missingBrowsers.push(base.browser);
      continue;
    }
    const deltas = [
      computeDelta(
        "p95_browser_cpu_percent",
        base.podCpuPercentiles?.p95,
        cur.podCpuPercentiles?.p95,
        maxIncreasePercent,
      ),
      computeDelta(
        "p95_browser_ram_kb",
        base.podRamKbPercentiles?.p95,
        cur.podRamKbPercentiles?.p95,
        maxIncreasePercent,
      ),
      computeDelta(
        "p95_tab_cpu_percent",
        base.tabCpuPercentiles?.p95,
        cur.tabCpuPercentiles?.p95,
        maxIncreasePercent,
      ),
      computeDelta(
        "p95_tab_ram_kb",
        base.tabRamKbPercentiles?.p95,
        cur.tabRamKbPercentiles?.p95,
        maxIncreasePercent,
      ),
    ].filter((d): d is MetricDelta => d !== undefined);

    resources.push({
      browser: base.browser,
      deltas,
      verdict: deltas.some((d) => d.status === "regression") ? "fail" : "pass",
    });
  }

  return { resources, missingBrowsers };
}
