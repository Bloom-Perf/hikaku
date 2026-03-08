// ============ Snapshot types ============

export type PercentileValues = {
    p50: number
    p75: number
    p90: number
    p95: number
    p99: number
}

export type HostMetrics = {
    hostname: string
    requestCount: number
    requestFinishedCount: number
    requestFailedCount: number
    responseCount: number
    durationPercentiles: PercentileValues
    durationSum: number
    durationCount: number
}

export type ScenarioMetrics = {
    scenario: string
    iteration: number
    hosts: HostMetrics[]
    totalRequests: number
    totalRequestsFailed: number
    errorRate: number
    aggregatedDurationPercentiles: PercentileValues
}

export type ResourceMetrics = {
    browser: string
    tabCpuPercentiles: PercentileValues
    tabRamKbPercentiles: PercentileValues
    podCpuPercentiles: PercentileValues
    podRamKbPercentiles: PercentileValues
}

export type RunSnapshot = {
    timestamp: string
    scenarios: ScenarioMetrics[]
    resources: ResourceMetrics[]
}

// ============ Baseline types ============

export type Baseline = {
    version: 1
    createdAt: string
    snapshot: RunSnapshot
}

// ============ Comparison types ============

export type MetricStatus = 'ok' | 'regression' | 'improvement'

export type MetricDelta = {
    metricName: string
    baselineValue: number
    currentValue: number
    deltaPercent: number
    status: MetricStatus
}

export type ScenarioComparison = {
    scenario: string
    iteration: number
    deltas: MetricDelta[]
    verdict: 'pass' | 'fail'
}

export type ComparisonReport = {
    timestamp: string
    overallVerdict: 'pass' | 'fail'
    scenarios: ScenarioComparison[]
    summary: {
        totalScenarios: number
        passed: number
        failed: number
        regressions: MetricDelta[]
    }
}

export type ComparisonThresholds = {
    /** Max allowed increase in percent for p95 latency. Default: 20 */
    defaultMaxIncreasePercent: number
    /** Max allowed increase in percent for error rate. Default: 10 */
    defaultMaxErrorRateIncreasePercent: number
    /** Per-scenario overrides keyed by "scenario:iteration" */
    perScenario?: Record<
        string,
        {
            maxIncreasePercent?: number
            maxErrorRateIncreasePercent?: number
        }
    >
}

export const DEFAULT_THRESHOLDS: ComparisonThresholds = {
    defaultMaxIncreasePercent: 20,
    defaultMaxErrorRateIncreasePercent: 10,
}
