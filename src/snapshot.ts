import type { Registry } from "prom-client";
import type {
  RunSnapshot,
  ScenarioMetrics,
  HostMetrics,
  ResourceMetrics,
  PercentileValues,
} from "./types";

// ============ Public API ============

/**
 * Create a structured RunSnapshot from a prom-client Registry.
 * Extracts Kyara-specific metrics and computes percentiles from histograms.
 */
export async function createSnapshot(registry: Registry): Promise<RunSnapshot> {
  const metricsJson = await registry.getMetricsAsJSON();
  const metricsMap = new Map<string, MetricData>();

  for (const metric of metricsJson) {
    metricsMap.set(metric.name, metric as unknown as MetricData);
  }

  return {
    timestamp: new Date().toISOString(),
    scenarios: buildScenarioMetrics(metricsMap),
    resources: buildResourceMetrics(metricsMap),
  };
}

/**
 * Compute a quantile from histogram buckets using linear interpolation.
 * Algorithm matches Prometheus histogram_quantile().
 *
 * @param quantile - value between 0 and 1
 * @param buckets - sorted ascending by le, with cumulative counts (last should be +Infinity)
 */
export function histogramQuantile(
  quantile: number,
  buckets: Array<{ le: number; count: number }>,
): number {
  if (buckets.length === 0) return NaN;
  if (quantile < 0 || quantile > 1) return NaN;

  const total = buckets[buckets.length - 1].count;
  if (total === 0) return NaN;

  const rank = quantile * total;

  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].count >= rank) {
      const bucketUpper = buckets[i].le;
      if (!isFinite(bucketUpper)) {
        // Quantile falls in +Inf bucket: return upper bound of last finite bucket
        return i > 0 ? buckets[i - 1].le : 0;
      }
      const bucketLower = i > 0 ? buckets[i - 1].le : 0;
      const countLower = i > 0 ? buckets[i - 1].count : 0;
      const countUpper = buckets[i].count;

      if (countUpper === countLower) return bucketLower;

      return (
        bucketLower +
        ((bucketUpper - bucketLower) * (rank - countLower)) /
          (countUpper - countLower)
      );
    }
  }

  // Should not reach here if buckets include +Inf
  return buckets.length >= 2 ? buckets[buckets.length - 2].le : NaN;
}

// ============ Internal types ============

type MetricValue = {
  value: number;
  metricName?: string;
  labels: Record<string, string | number>;
};

type MetricData = {
  name: string;
  help: string;
  type: string;
  values: MetricValue[];
  aggregator: string;
};

// ============ Internal functions ============

function computePercentiles(
  buckets: Array<{ le: number; count: number }>,
): PercentileValues {
  return {
    p50: histogramQuantile(0.5, buckets),
    p75: histogramQuantile(0.75, buckets),
    p90: histogramQuantile(0.9, buckets),
    p95: histogramQuantile(0.95, buckets),
    p99: histogramQuantile(0.99, buckets),
  };
}

/**
 * Extract histogram buckets for a specific label combination.
 * Filters for bucket entries (those with a `le` label) and returns sorted by le.
 */
function extractBuckets(
  values: MetricValue[],
  labelMatch: Record<string, string | number>,
): Array<{ le: number; count: number }> {
  const buckets: Array<{ le: number; count: number }> = [];

  for (const v of values) {
    // Must be a bucket entry
    if (v.labels.le === undefined) continue;

    // Check all label filters match
    let matches = true;
    for (const [key, val] of Object.entries(labelMatch)) {
      if (String(v.labels[key]) !== String(val)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    const le = v.labels.le === "+Inf" ? Infinity : Number(v.labels.le);
    buckets.push({ le, count: v.value });
  }

  buckets.sort((a, b) => a.le - b.le);
  return buckets;
}

/**
 * Get the sum and count values for a histogram with specific labels.
 */
function extractSumCount(
  values: MetricValue[],
  metricName: string,
  labelMatch: Record<string, string | number>,
): { sum: number; count: number } {
  let sum = 0;
  let count = 0;

  for (const v of values) {
    if (v.labels.le !== undefined) continue;

    let matches = true;
    for (const [key, val] of Object.entries(labelMatch)) {
      if (String(v.labels[key]) !== String(val)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    if (v.metricName === `${metricName}_sum`) sum = v.value;
    if (v.metricName === `${metricName}_count`) count = v.value;
  }

  return { sum, count };
}

/**
 * Get counter value for a specific label combination.
 */
function getCounterValue(
  metric: MetricData | undefined,
  labelMatch: Record<string, string | number>,
): number {
  if (!metric) return 0;

  for (const v of metric.values) {
    let matches = true;
    for (const [key, val] of Object.entries(labelMatch)) {
      if (String(v.labels[key]) !== String(val)) {
        matches = false;
        break;
      }
    }
    if (matches) return v.value;
  }

  return 0;
}

type ScenarioIterationKey = string; // "scenario:iteration"

function makeKey(scenario: string, iteration: number): ScenarioIterationKey {
  return `${scenario}:${iteration}`;
}

/**
 * Discover all unique (scenario, iteration) pairs from counter/histogram metrics.
 */
function discoverScenarioIterations(
  metricsMap: Map<string, MetricData>,
): Map<ScenarioIterationKey, { scenario: string; iteration: number }> {
  const result = new Map<
    ScenarioIterationKey,
    { scenario: string; iteration: number }
  >();

  const relevantMetrics = [
    "browser_request",
    "browser_request_finished",
    "browser_request_failed",
    "browser_response",
    "browser_request_duration_seconds",
    "browser_tab_started",
  ];

  for (const name of relevantMetrics) {
    const metric = metricsMap.get(name);
    if (!metric) continue;

    for (const v of metric.values) {
      const scenario = v.labels.scenario;
      const iteration = v.labels.iteration;
      if (scenario !== undefined && iteration !== undefined) {
        const key = makeKey(String(scenario), Number(iteration));
        if (!result.has(key)) {
          result.set(key, {
            scenario: String(scenario),
            iteration: Number(iteration),
          });
        }
      }
    }
  }

  return result;
}

/**
 * Discover all unique hostnames for a given (scenario, iteration) pair.
 */
function discoverHostnames(
  metricsMap: Map<string, MetricData>,
  scenario: string,
  iteration: number,
): string[] {
  const hostnames = new Set<string>();

  const relevantMetrics = [
    "browser_request",
    "browser_request_finished",
    "browser_request_duration_seconds",
  ];

  for (const name of relevantMetrics) {
    const metric = metricsMap.get(name);
    if (!metric) continue;

    for (const v of metric.values) {
      if (
        String(v.labels.scenario) === scenario &&
        Number(v.labels.iteration) === iteration &&
        v.labels.hostname !== undefined
      ) {
        hostnames.add(String(v.labels.hostname));
      }
    }
  }

  return Array.from(hostnames).sort();
}

function buildScenarioMetrics(
  metricsMap: Map<string, MetricData>,
): ScenarioMetrics[] {
  const scenarioIterations = discoverScenarioIterations(metricsMap);
  const results: ScenarioMetrics[] = [];

  const requestMetric = metricsMap.get("browser_request");
  const finishedMetric = metricsMap.get("browser_request_finished");
  const failedMetric = metricsMap.get("browser_request_failed");
  const responseMetric = metricsMap.get("browser_response");
  const durationMetric = metricsMap.get("browser_request_duration_seconds");

  for (const [, { scenario, iteration }] of scenarioIterations) {
    const hostnames = discoverHostnames(metricsMap, scenario, iteration);
    const hosts: HostMetrics[] = [];

    let totalRequests = 0;
    let totalFailed = 0;

    // Collect all duration buckets across hosts for aggregated percentiles
    const allBuckets = new Map<number, number>(); // le -> cumulative count

    for (const hostname of hostnames) {
      const labels = { scenario, iteration, hostname };

      const requestCount = getCounterValue(requestMetric, labels);
      const requestFinishedCount = getCounterValue(finishedMetric, labels);
      const requestFailedCount = getCounterValue(failedMetric, labels);
      const responseCount = getCounterValue(responseMetric, labels);

      totalRequests += requestCount;
      totalFailed += requestFailedCount;

      let durationPercentiles: PercentileValues = {
        p50: 0,
        p75: 0,
        p90: 0,
        p95: 0,
        p99: 0,
      };
      let durationSum = 0;
      let durationCount = 0;

      if (durationMetric) {
        const buckets = extractBuckets(durationMetric.values, labels);
        if (buckets.length > 0) {
          durationPercentiles = computePercentiles(buckets);

          // Accumulate for aggregated percentiles
          for (const b of buckets) {
            allBuckets.set(b.le, (allBuckets.get(b.le) || 0) + b.count);
          }
        }

        const sc = extractSumCount(
          durationMetric.values,
          "browser_request_duration_seconds",
          labels,
        );
        durationSum = sc.sum;
        durationCount = sc.count;
      }

      hosts.push({
        hostname,
        requestCount,
        requestFinishedCount,
        requestFailedCount,
        responseCount,
        durationPercentiles,
        durationSum,
        durationCount,
      });
    }

    // Compute aggregated percentiles from merged buckets
    let aggregatedDurationPercentiles: PercentileValues = {
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
    };

    if (allBuckets.size > 0) {
      const mergedBuckets = Array.from(allBuckets.entries())
        .map(([le, count]) => ({ le, count }))
        .sort((a, b) => a.le - b.le);
      aggregatedDurationPercentiles = computePercentiles(mergedBuckets);
    }

    results.push({
      scenario,
      iteration,
      hosts,
      totalRequests,
      totalRequestsFailed: totalFailed,
      errorRate: totalRequests > 0 ? totalFailed / totalRequests : 0,
      aggregatedDurationPercentiles,
    });
  }

  return results.sort((a, b) => {
    const nameCompare = a.scenario.localeCompare(b.scenario);
    return nameCompare !== 0 ? nameCompare : a.iteration - b.iteration;
  });
}

function buildResourceMetrics(
  metricsMap: Map<string, MetricData>,
): ResourceMetrics[] {
  const tabCpu = metricsMap.get("dsd_tab_cpu_percent");
  const tabRam = metricsMap.get("dsd_tab_ram_kb");
  const podCpu = metricsMap.get("dsd_pod_cpu_percent");
  const podRam = metricsMap.get("dsd_pod_ram_kb");

  // Discover all browser labels
  const browsers = new Set<string>();
  for (const metric of [tabCpu, tabRam, podCpu, podRam]) {
    if (!metric) continue;
    for (const v of metric.values) {
      if (v.labels.browser !== undefined) {
        browsers.add(String(v.labels.browser));
      }
    }
  }

  const zeroPercentiles: PercentileValues = {
    p50: 0,
    p75: 0,
    p90: 0,
    p95: 0,
    p99: 0,
  };

  return Array.from(browsers)
    .sort()
    .map((browser) => {
      const labels = { browser };
      return {
        browser,
        tabCpuPercentiles: tabCpu
          ? computePercentiles(extractBuckets(tabCpu.values, labels))
          : zeroPercentiles,
        tabRamKbPercentiles: tabRam
          ? computePercentiles(extractBuckets(tabRam.values, labels))
          : zeroPercentiles,
        podCpuPercentiles: podCpu
          ? computePercentiles(extractBuckets(podCpu.values, labels))
          : zeroPercentiles,
        podRamKbPercentiles: podRam
          ? computePercentiles(extractBuckets(podRam.values, labels))
          : zeroPercentiles,
      };
    });
}
