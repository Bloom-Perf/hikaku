import { expect } from 'chai'
import prom from 'prom-client'
import { histogramQuantile, createSnapshot } from '../src/snapshot'

describe('histogramQuantile', () => {
    it('returns NaN for empty buckets', () => {
        expect(histogramQuantile(0.5, [])).to.be.NaN
    })

    it('returns NaN for quantile outside [0, 1]', () => {
        const buckets = [
            { le: 1, count: 5 },
            { le: Infinity, count: 5 },
        ]
        expect(histogramQuantile(-0.1, buckets)).to.be.NaN
        expect(histogramQuantile(1.1, buckets)).to.be.NaN
    })

    it('returns NaN when total count is 0', () => {
        const buckets = [
            { le: 1, count: 0 },
            { le: Infinity, count: 0 },
        ]
        expect(histogramQuantile(0.5, buckets)).to.be.NaN
    })

    it('computes p50 with linear interpolation', () => {
        // 10 observations: 2 in [0, 0.1], 3 in (0.1, 0.5], 3 in (0.5, 1.0], 2 in (1.0, 5.0]
        const buckets = [
            { le: 0.1, count: 2 },
            { le: 0.5, count: 5 },
            { le: 1.0, count: 8 },
            { le: 5.0, count: 10 },
            { le: Infinity, count: 10 },
        ]

        // p50: rank = 0.5 * 10 = 5, falls in bucket le=0.5 (count=5 >= 5)
        // interpolation: 0.1 + (0.5 - 0.1) * (5 - 2) / (5 - 2) = 0.1 + 0.4 = 0.5
        const p50 = histogramQuantile(0.5, buckets)
        expect(p50).to.be.closeTo(0.5, 0.001)
    })

    it('computes p95 with linear interpolation', () => {
        const buckets = [
            { le: 0.1, count: 2 },
            { le: 0.5, count: 5 },
            { le: 1.0, count: 8 },
            { le: 5.0, count: 10 },
            { le: Infinity, count: 10 },
        ]

        // p95: rank = 0.95 * 10 = 9.5, falls in bucket le=5.0 (count=10 >= 9.5)
        // interpolation: 1.0 + (5.0 - 1.0) * (9.5 - 8) / (10 - 8) = 1.0 + 4.0 * 0.75 = 4.0
        const p95 = histogramQuantile(0.95, buckets)
        expect(p95).to.be.closeTo(4.0, 0.001)
    })

    it('handles all observations in first bucket', () => {
        const buckets = [
            { le: 0.1, count: 10 },
            { le: 0.5, count: 10 },
            { le: Infinity, count: 10 },
        ]

        // p50: rank = 5, first bucket has 10 >= 5
        // interpolation: 0 + (0.1 - 0) * (5 - 0) / (10 - 0) = 0.05
        const p50 = histogramQuantile(0.5, buckets)
        expect(p50).to.be.closeTo(0.05, 0.001)
    })

    it('handles all observations in +Inf bucket', () => {
        const buckets = [
            { le: 0.1, count: 0 },
            { le: 0.5, count: 0 },
            { le: Infinity, count: 10 },
        ]

        // All in +Inf → return upper bound of last finite bucket
        const p50 = histogramQuantile(0.5, buckets)
        expect(p50).to.equal(0.5)
    })

    it('computes quantile 0 (minimum)', () => {
        const buckets = [
            { le: 0.1, count: 5 },
            { le: 0.5, count: 10 },
            { le: Infinity, count: 10 },
        ]

        // rank = 0, first bucket count (5) >= 0
        // interpolation: 0 + (0.1 - 0) * (0 - 0) / (5 - 0) = 0
        const q0 = histogramQuantile(0, buckets)
        expect(q0).to.equal(0)
    })

    it('computes quantile 1 (maximum)', () => {
        const buckets = [
            { le: 0.1, count: 5 },
            { le: 0.5, count: 10 },
            { le: Infinity, count: 10 },
        ]

        // rank = 10, +Inf bucket count (10) >= 10 → return last finite le
        const q1 = histogramQuantile(1, buckets)
        expect(q1).to.equal(0.5)
    })
})

describe('createSnapshot', () => {
    let registry: prom.Registry

    beforeEach(() => {
        registry = new prom.Registry()
    })

    it('creates a snapshot with scenario metrics from counters and histograms', async () => {
        // Create Kyara-like metrics
        const browserRequest = new prom.Counter({
            name: 'browser_request',
            help: 'HTTP requests',
            labelNames: ['hostname', 'scenario', 'iteration'],
            registers: [registry],
        })
        const browserRequestFinished = new prom.Counter({
            name: 'browser_request_finished',
            help: 'Finished requests',
            labelNames: ['hostname', 'scenario', 'iteration'],
            registers: [registry],
        })
        const browserRequestFailed = new prom.Counter({
            name: 'browser_request_failed',
            help: 'Failed requests',
            labelNames: ['hostname', 'scenario', 'iteration'],
            registers: [registry],
        })
        const browserResponse = new prom.Counter({
            name: 'browser_response',
            help: 'Responses',
            labelNames: ['hostname', 'scenario', 'iteration'],
            registers: [registry],
        })
        const browserRequestDuration = new prom.Histogram({
            name: 'browser_request_duration_seconds',
            help: 'Duration',
            labelNames: ['hostname', 'scenario', 'iteration'],
            buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            registers: [registry],
        })

        // Simulate a "Login" scenario, iteration 0, to example.com
        const labels = { hostname: 'example.com', scenario: 'Login', iteration: 0 }
        browserRequest.inc(labels, 10)
        browserRequestFinished.inc(labels, 9)
        browserRequestFailed.inc(labels, 1)
        browserResponse.inc(labels, 9)

        // Simulate latencies: mix of fast and slow requests
        for (const d of [0.02, 0.03, 0.04, 0.08, 0.12, 0.2, 0.3, 0.6, 1.5]) {
            browserRequestDuration.observe(labels, d)
        }

        const snapshot = await createSnapshot(registry)

        expect(snapshot.timestamp).to.be.a('string')
        expect(snapshot.scenarios).to.have.length(1)

        const scenario = snapshot.scenarios[0]
        expect(scenario.scenario).to.equal('Login')
        expect(scenario.iteration).to.equal(0)
        expect(scenario.totalRequests).to.equal(10)
        expect(scenario.totalRequestsFailed).to.equal(1)
        expect(scenario.errorRate).to.be.closeTo(0.1, 0.001)

        expect(scenario.hosts).to.have.length(1)
        expect(scenario.hosts[0].hostname).to.equal('example.com')
        expect(scenario.hosts[0].requestCount).to.equal(10)

        // Percentiles should be reasonable values
        expect(scenario.aggregatedDurationPercentiles.p50).to.be.greaterThan(0)
        expect(scenario.aggregatedDurationPercentiles.p95).to.be.greaterThan(
            scenario.aggregatedDurationPercentiles.p50
        )
    })

    it('groups metrics by scenario and iteration', async () => {
        const browserRequest = new prom.Counter({
            name: 'browser_request',
            help: 'HTTP requests',
            labelNames: ['hostname', 'scenario', 'iteration'],
            registers: [registry],
        })

        browserRequest.inc({ hostname: 'a.com', scenario: 'Login', iteration: 0 }, 5)
        browserRequest.inc({ hostname: 'a.com', scenario: 'Login', iteration: 1 }, 3)
        browserRequest.inc({ hostname: 'a.com', scenario: 'Checkout', iteration: 0 }, 7)

        const snapshot = await createSnapshot(registry)

        expect(snapshot.scenarios).to.have.length(3)

        const login0 = snapshot.scenarios.find(
            (s) => s.scenario === 'Login' && s.iteration === 0
        )
        const login1 = snapshot.scenarios.find(
            (s) => s.scenario === 'Login' && s.iteration === 1
        )
        const checkout0 = snapshot.scenarios.find(
            (s) => s.scenario === 'Checkout' && s.iteration === 0
        )

        expect(login0?.totalRequests).to.equal(5)
        expect(login1?.totalRequests).to.equal(3)
        expect(checkout0?.totalRequests).to.equal(7)
    })

    it('handles multiple hostnames within a scenario', async () => {
        const browserRequest = new prom.Counter({
            name: 'browser_request',
            help: 'HTTP requests',
            labelNames: ['hostname', 'scenario', 'iteration'],
            registers: [registry],
        })

        browserRequest.inc({ hostname: 'api.com', scenario: 'Login', iteration: 0 }, 5)
        browserRequest.inc({ hostname: 'cdn.com', scenario: 'Login', iteration: 0 }, 3)

        const snapshot = await createSnapshot(registry)

        expect(snapshot.scenarios).to.have.length(1)
        expect(snapshot.scenarios[0].hosts).to.have.length(2)
        expect(snapshot.scenarios[0].totalRequests).to.equal(8)
    })

    it('creates resource metrics from histograms', async () => {
        new prom.Histogram({
            name: 'dsd_tab_cpu_percent',
            help: 'CPU',
            labelNames: ['browser'],
            registers: [registry],
        }).observe({ browser: 'firefox' }, 25)

        new prom.Histogram({
            name: 'dsd_tab_ram_kb',
            help: 'RAM',
            labelNames: ['browser'],
            registers: [registry],
        }).observe({ browser: 'firefox' }, 500000)

        const snapshot = await createSnapshot(registry)

        expect(snapshot.resources).to.have.length(1)
        expect(snapshot.resources[0].browser).to.equal('firefox')
    })

    it('returns empty arrays when no metrics are registered', async () => {
        const snapshot = await createSnapshot(registry)

        expect(snapshot.scenarios).to.deep.equal([])
        expect(snapshot.resources).to.deep.equal([])
    })
})
