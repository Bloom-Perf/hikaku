import { expect } from 'chai'
import { compare } from '../src/compare'
import type { RunSnapshot, Baseline, ScenarioMetrics } from '../src/types'

function makeScenario(overrides: Partial<ScenarioMetrics> = {}): ScenarioMetrics {
    return {
        scenario: 'Login',
        iteration: 0,
        hosts: [],
        totalRequests: 100,
        totalRequestsFailed: 1,
        errorRate: 0.01,
        aggregatedDurationPercentiles: {
            p50: 0.1,
            p75: 0.2,
            p90: 0.4,
            p95: 0.5,
            p99: 0.8,
        },
        ...overrides,
    }
}

function makeSnapshot(scenarios: ScenarioMetrics[]): RunSnapshot {
    return {
        timestamp: '2026-03-08T12:00:00.000Z',
        scenarios,
        resources: [],
    }
}

function makeBaseline(scenarios: ScenarioMetrics[]): Baseline {
    return {
        version: 1,
        createdAt: '2026-03-07T12:00:00.000Z',
        snapshot: makeSnapshot(scenarios),
    }
}

describe('compare', () => {
    it('returns pass when snapshots are identical', () => {
        const scenario = makeScenario()
        const report = compare(makeSnapshot([scenario]), makeBaseline([scenario]))

        expect(report.overallVerdict).to.equal('pass')
        expect(report.scenarios).to.have.length(1)
        expect(report.scenarios[0].verdict).to.equal('pass')

        const p95Delta = report.scenarios[0].deltas.find((d) => d.metricName === 'p95_latency')
        expect(p95Delta?.deltaPercent).to.equal(0)
        expect(p95Delta?.status).to.equal('ok')
    })

    it('returns pass when regression is below threshold', () => {
        const baselineScenario = makeScenario()
        const currentScenario = makeScenario({
            aggregatedDurationPercentiles: {
                p50: 0.1,
                p75: 0.2,
                p90: 0.4,
                p95: 0.575, // +15%
                p99: 0.8,
            },
        })

        const report = compare(makeSnapshot([currentScenario]), makeBaseline([baselineScenario]))

        expect(report.overallVerdict).to.equal('pass')
        const p95Delta = report.scenarios[0].deltas.find((d) => d.metricName === 'p95_latency')
        expect(p95Delta?.deltaPercent).to.be.closeTo(15, 0.1)
        expect(p95Delta?.status).to.equal('ok')
    })

    it('returns fail when p95 regression exceeds threshold', () => {
        const baselineScenario = makeScenario()
        const currentScenario = makeScenario({
            aggregatedDurationPercentiles: {
                p50: 0.1,
                p75: 0.2,
                p90: 0.4,
                p95: 0.625, // +25%
                p99: 0.8,
            },
        })

        const report = compare(makeSnapshot([currentScenario]), makeBaseline([baselineScenario]))

        expect(report.overallVerdict).to.equal('fail')
        expect(report.summary.failed).to.equal(1)
        expect(report.summary.regressions).to.have.length(1)
        expect(report.summary.regressions[0].metricName).to.equal('p95_latency')
    })

    it('marks improvement when latency decreases significantly', () => {
        const baselineScenario = makeScenario()
        const currentScenario = makeScenario({
            aggregatedDurationPercentiles: {
                p50: 0.1,
                p75: 0.2,
                p90: 0.4,
                p95: 0.35, // -30%
                p99: 0.8,
            },
        })

        const report = compare(makeSnapshot([currentScenario]), makeBaseline([baselineScenario]))

        expect(report.overallVerdict).to.equal('pass')
        const p95Delta = report.scenarios[0].deltas.find((d) => d.metricName === 'p95_latency')
        expect(p95Delta?.status).to.equal('improvement')
    })

    it('returns fail when error rate regression exceeds threshold', () => {
        const baselineScenario = makeScenario({ errorRate: 0.01 })
        const currentScenario = makeScenario({ errorRate: 0.15 }) // huge jump

        const report = compare(makeSnapshot([currentScenario]), makeBaseline([baselineScenario]))

        expect(report.overallVerdict).to.equal('fail')
        const errorDelta = report.scenarios[0].deltas.find((d) => d.metricName === 'error_rate')
        expect(errorDelta?.status).to.equal('regression')
    })

    it('applies per-scenario threshold overrides', () => {
        const baselineScenario = makeScenario()
        const currentScenario = makeScenario({
            aggregatedDurationPercentiles: {
                p50: 0.1,
                p75: 0.2,
                p90: 0.4,
                p95: 0.65, // +30%
                p99: 0.8,
            },
        })

        // With default threshold (20%), this would fail
        // But with override (50%), it passes
        const report = compare(makeSnapshot([currentScenario]), makeBaseline([baselineScenario]), {
            perScenario: {
                'Login:0': { maxIncreasePercent: 50 },
            },
        })

        expect(report.overallVerdict).to.equal('pass')
    })

    it('skips new scenarios not present in baseline', () => {
        const baselineScenario = makeScenario({ scenario: 'Login' })
        const newScenario = makeScenario({ scenario: 'Checkout' })

        const report = compare(
            makeSnapshot([baselineScenario, newScenario]),
            makeBaseline([baselineScenario])
        )

        // Only Login is compared, Checkout is skipped
        expect(report.scenarios).to.have.length(1)
        expect(report.scenarios[0].scenario).to.equal('Login')
        expect(report.overallVerdict).to.equal('pass')
    })

    it('fails overall when one of multiple scenarios fails', () => {
        const loginBaseline = makeScenario({ scenario: 'Login' })
        const checkoutBaseline = makeScenario({ scenario: 'Checkout' })

        const loginCurrent = makeScenario({ scenario: 'Login' }) // unchanged
        const checkoutCurrent = makeScenario({
            scenario: 'Checkout',
            aggregatedDurationPercentiles: {
                p50: 0.1,
                p75: 0.2,
                p90: 0.4,
                p95: 1.0, // +100%, regression
                p99: 0.8,
            },
        })

        const report = compare(
            makeSnapshot([loginCurrent, checkoutCurrent]),
            makeBaseline([loginBaseline, checkoutBaseline])
        )

        expect(report.overallVerdict).to.equal('fail')
        expect(report.summary.passed).to.equal(1)
        expect(report.summary.failed).to.equal(1)
    })

    it('handles zero baseline values gracefully', () => {
        const baselineScenario = makeScenario({
            aggregatedDurationPercentiles: {
                p50: 0,
                p75: 0,
                p90: 0,
                p95: 0,
                p99: 0,
            },
        })
        const currentScenario = makeScenario({
            aggregatedDurationPercentiles: {
                p50: 0.1,
                p75: 0.2,
                p90: 0.4,
                p95: 0.5,
                p99: 0.8,
            },
        })

        const report = compare(makeSnapshot([currentScenario]), makeBaseline([baselineScenario]))

        // Baseline was 0, current is non-zero → Infinity delta → regression
        expect(report.overallVerdict).to.equal('fail')
        const p95Delta = report.scenarios[0].deltas.find((d) => d.metricName === 'p95_latency')
        expect(p95Delta?.deltaPercent).to.equal(Infinity)
        expect(p95Delta?.status).to.equal('regression')
    })

    it('handles both baseline and current being zero', () => {
        const scenario = makeScenario({
            aggregatedDurationPercentiles: {
                p50: 0,
                p75: 0,
                p90: 0,
                p95: 0,
                p99: 0,
            },
            errorRate: 0,
        })

        const report = compare(makeSnapshot([scenario]), makeBaseline([scenario]))

        expect(report.overallVerdict).to.equal('pass')
        const p95Delta = report.scenarios[0].deltas.find((d) => d.metricName === 'p95_latency')
        expect(p95Delta?.deltaPercent).to.equal(0)
    })
})
