// ============ Metrics source ============

/** One sample of a metric, as returned by `Registry#getMetricsAsJSON()` */
export type MetricSample = {
  value: number;
  /** Set on the samples of a histogram: `<name>_bucket`, `<name>_sum`, `<name>_count` */
  metricName?: string;
  labels: Partial<Record<string, string | number>>;
};

/** One metric with its samples, as returned by `Registry#getMetricsAsJSON()` */
export type MetricFamily = {
  name: string;
  values: MetricSample[];
};

/**
 * Where the metrics are read from: a Prometheus registry of
 * [`@prometheus-io/client`](https://www.npmjs.com/package/@prometheus-io/client)
 * or of `prom-client` (its former name), or any object with the same `getMetricsAsJSON()`.
 */
export type MetricsSource = {
  getMetricsAsJSON(): Promise<MetricFamily[]>;
};

// ============ Snapshot types ============

export type PercentileValues = {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
};

export type HostMetrics = {
  hostname: string;
  requestCount: number;
  requestFinishedCount: number;
  requestFailedCount: number;
  responseCount: number;
  durationPercentiles: PercentileValues;
  durationSum: number;
  durationCount: number;
};

export type ScenarioMetrics = {
  scenario: string;
  iteration: number;
  hosts: HostMetrics[];
  totalRequests: number;
  totalRequestsFailed: number;
  errorRate: number;
  aggregatedDurationPercentiles: PercentileValues;
};

/**
 * CPU (% of one core) and memory (kB) of a browser, from Kyara's `dsd_*` histograms.
 * A percentile is `NaN` (`null` once saved) when the metric has no sample for the browser.
 */
export type ResourceMetrics = {
  browser: string;
  /** Each process rendering pages (tab) */
  tabCpuPercentiles: PercentileValues;
  tabRamKbPercentiles: PercentileValues;
  /** The whole browser (all its processes) */
  podCpuPercentiles: PercentileValues;
  podRamKbPercentiles: PercentileValues;
};

export type RunSnapshot = {
  timestamp: string;
  scenarios: ScenarioMetrics[];
  resources: ResourceMetrics[];
};

// ============ Baseline types ============

export type Baseline = {
  version: 1;
  createdAt: string;
  snapshot: RunSnapshot;
};

// ============ Comparison types ============

export type MetricStatus = "ok" | "regression" | "improvement";

export type MetricDelta = {
  metricName: string;
  baselineValue: number;
  currentValue: number;
  /** `Infinity` when the baseline value is 0 and the current one is not */
  deltaPercent: number;
  status: MetricStatus;
};

/** A regression, with the scenario or the browser it was found in */
export type Regression = MetricDelta & {
  /** Set for a scenario metric (latency, error rate) */
  scenario?: string;
  iteration?: number;
  /** Set for a resource metric (CPU, memory) */
  browser?: string;
};

export type ScenarioComparison = {
  scenario: string;
  iteration: number;
  deltas: MetricDelta[];
  verdict: "pass" | "fail";
};

export type ResourceComparison = {
  browser: string;
  deltas: MetricDelta[];
  verdict: "pass" | "fail";
};

export type ScenarioKey = {
  scenario: string;
  iteration: number;
};

export type ComparisonReport = {
  timestamp: string;
  overallVerdict: "pass" | "fail";
  scenarios: ScenarioComparison[];
  /** Resource consumption of each browser measured in both runs */
  resources: ResourceComparison[];
  summary: {
    /** Scenario iterations compared */
    totalScenarios: number;
    passed: number;
    failed: number;
    regressions: Regression[];
    /** In the baseline but not in the current run: the verdict is "fail" */
    missingScenarios: ScenarioKey[];
    /** In the current run but not in the baseline: not compared */
    newScenarios: ScenarioKey[];
    /** Browsers with resource metrics in the baseline but not in the current run: not compared */
    missingBrowsers: string[];
  };
};

export type ComparisonThresholds = {
  /** Max allowed increase in percent for p50 and p95 latency. Default: 20 */
  defaultMaxIncreasePercent: number;
  /** Max allowed increase in percent for error rate. Default: 10 */
  defaultMaxErrorRateIncreasePercent: number;
  /** Max allowed increase in percent for the p95 CPU and memory of the browsers. Default: 20 */
  defaultMaxResourceIncreasePercent: number;
  /**
   * Per-scenario overrides keyed by "scenario:iteration" (one iteration) or "scenario"
   * (all its iterations); "scenario:iteration" wins over "scenario"
   */
  perScenario?: Record<
    string,
    {
      maxIncreasePercent?: number;
      maxErrorRateIncreasePercent?: number;
    }
  >;
};

export const DEFAULT_THRESHOLDS: ComparisonThresholds = {
  defaultMaxIncreasePercent: 20,
  defaultMaxErrorRateIncreasePercent: 10,
  defaultMaxResourceIncreasePercent: 20,
};

// ============ LLM Report types ============

/** Generic LLM provider interface — implement this to use any LLM backend */
export type LlmProvider = {
  complete(systemPrompt: string, userMessage: string): Promise<string>;
};

/** Options for generateReport */
export type ReportOptions = {
  /** LLM provider to use for generating the report */
  provider: LlmProvider;
  /** Report language. Default: 'en' */
  locale?: "en" | "fr";
  /** Output format. Default: 'markdown' */
  format?: "markdown" | "text";
  /** Include investigation recommendations. Default: true */
  includeRecommendations?: boolean;
};
