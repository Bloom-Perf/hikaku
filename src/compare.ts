import type {
    RunSnapshot,
    Baseline,
    ComparisonReport,
    ComparisonThresholds,
    ScenarioComparison,
    MetricDelta,
    MetricStatus,
    ScenarioMetrics,
} from './types'
import { DEFAULT_THRESHOLDS } from './types'

/**
 * Compare a current RunSnapshot against a Baseline.
 * Returns a ComparisonReport with per-scenario verdicts and an overall verdict.
 */
export function compare(
    current: RunSnapshot,
    baseline: Baseline,
    thresholds?: Partial<ComparisonThresholds>
): ComparisonReport {
    const mergedThresholds: ComparisonThresholds = {
        ...DEFAULT_THRESHOLDS,
        ...thresholds,
    }

    const baselineMap = new Map<string, ScenarioMetrics>()
    for (const s of baseline.snapshot.scenarios) {
        baselineMap.set(makeKey(s.scenario, s.iteration), s)
    }

    const scenarioComparisons: ScenarioComparison[] = []
    const allRegressions: MetricDelta[] = []

    for (const currentScenario of current.scenarios) {
        const key = makeKey(currentScenario.scenario, currentScenario.iteration)
        const baselineScenario = baselineMap.get(key)

        // New scenario not in baseline: skip
        if (!baselineScenario) continue

        const { maxIncreasePercent, maxErrorRateIncreasePercent } =
            getThresholdsForScenario(key, mergedThresholds)

        const comparison = compareScenario(
            currentScenario,
            baselineScenario,
            maxIncreasePercent,
            maxErrorRateIncreasePercent
        )

        scenarioComparisons.push(comparison)

        for (const delta of comparison.deltas) {
            if (delta.status === 'regression') {
                allRegressions.push(delta)
            }
        }
    }

    const passed = scenarioComparisons.filter((s) => s.verdict === 'pass').length
    const failed = scenarioComparisons.filter((s) => s.verdict === 'fail').length

    return {
        timestamp: new Date().toISOString(),
        overallVerdict: failed > 0 ? 'fail' : 'pass',
        scenarios: scenarioComparisons,
        summary: {
            totalScenarios: scenarioComparisons.length,
            passed,
            failed,
            regressions: allRegressions,
        },
    }
}

// ============ Internal ============

function makeKey(scenario: string, iteration: number): string {
    return `${scenario}:${iteration}`
}

function getThresholdsForScenario(
    key: string,
    thresholds: ComparisonThresholds
): { maxIncreasePercent: number; maxErrorRateIncreasePercent: number } {
    const override = thresholds.perScenario?.[key]
    return {
        maxIncreasePercent: override?.maxIncreasePercent ?? thresholds.defaultMaxIncreasePercent,
        maxErrorRateIncreasePercent:
            override?.maxErrorRateIncreasePercent ??
            thresholds.defaultMaxErrorRateIncreasePercent,
    }
}

function computeDeltaPercent(baselineValue: number, currentValue: number): number {
    if (baselineValue === 0) return currentValue === 0 ? 0 : Infinity
    return ((currentValue - baselineValue) / baselineValue) * 100
}

function evaluateStatus(deltaPercent: number, maxIncreasePercent: number): MetricStatus {
    if (deltaPercent > maxIncreasePercent) return 'regression'
    if (deltaPercent < -maxIncreasePercent) return 'improvement'
    return 'ok'
}

function compareScenario(
    current: ScenarioMetrics,
    baseline: ScenarioMetrics,
    maxIncreasePercent: number,
    maxErrorRateIncreasePercent: number
): ScenarioComparison {
    const deltas: MetricDelta[] = []
    let hasFailure = false

    // Compare p95 latency
    const p95Delta = computeDeltaPercent(
        baseline.aggregatedDurationPercentiles.p95,
        current.aggregatedDurationPercentiles.p95
    )
    const p95Status = evaluateStatus(p95Delta, maxIncreasePercent)
    deltas.push({
        metricName: 'p95_latency',
        baselineValue: baseline.aggregatedDurationPercentiles.p95,
        currentValue: current.aggregatedDurationPercentiles.p95,
        deltaPercent: p95Delta,
        status: p95Status,
    })
    if (p95Status === 'regression') hasFailure = true

    // Compare p50 latency
    const p50Delta = computeDeltaPercent(
        baseline.aggregatedDurationPercentiles.p50,
        current.aggregatedDurationPercentiles.p50
    )
    const p50Status = evaluateStatus(p50Delta, maxIncreasePercent)
    deltas.push({
        metricName: 'p50_latency',
        baselineValue: baseline.aggregatedDurationPercentiles.p50,
        currentValue: current.aggregatedDurationPercentiles.p50,
        deltaPercent: p50Delta,
        status: p50Status,
    })
    if (p50Status === 'regression') hasFailure = true

    // Compare error rate
    const errorRateDelta = computeDeltaPercent(baseline.errorRate, current.errorRate)
    const errorRateStatus = evaluateStatus(errorRateDelta, maxErrorRateIncreasePercent)
    deltas.push({
        metricName: 'error_rate',
        baselineValue: baseline.errorRate,
        currentValue: current.errorRate,
        deltaPercent: errorRateDelta,
        status: errorRateStatus,
    })
    if (errorRateStatus === 'regression') hasFailure = true

    // Informational: total requests (no verdict impact)
    const reqDelta = computeDeltaPercent(baseline.totalRequests, current.totalRequests)
    deltas.push({
        metricName: 'total_requests',
        baselineValue: baseline.totalRequests,
        currentValue: current.totalRequests,
        deltaPercent: reqDelta,
        status: 'ok',
    })

    return {
        scenario: current.scenario,
        iteration: current.iteration,
        deltas,
        verdict: hasFailure ? 'fail' : 'pass',
    }
}
