import { expect } from "chai";
import { compare } from "../src/compare.js";
import type {
  RunSnapshot,
  Baseline,
  ResourceMetrics,
  ScenarioMetrics,
} from "../src/types.js";

function makeScenario(
  overrides: Partial<ScenarioMetrics> = {},
): ScenarioMetrics {
  return {
    scenario: "Login",
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
  };
}

function makeSnapshot(scenarios: ScenarioMetrics[]): RunSnapshot {
  return {
    timestamp: "2026-03-08T12:00:00.000Z",
    scenarios,
    resources: [],
  };
}

function makeBaseline(scenarios: ScenarioMetrics[]): Baseline {
  return {
    version: 1,
    createdAt: "2026-03-07T12:00:00.000Z",
    snapshot: makeSnapshot(scenarios),
  };
}

describe("compare", () => {
  it("returns pass when snapshots are identical", () => {
    const scenario = makeScenario();
    const report = compare(makeSnapshot([scenario]), makeBaseline([scenario]));

    expect(report.overallVerdict).to.equal("pass");
    expect(report.scenarios).to.have.length(1);
    expect(report.scenarios[0].verdict).to.equal("pass");

    const p95Delta = report.scenarios[0].deltas.find(
      (d) => d.metricName === "p95_latency",
    );
    expect(p95Delta?.deltaPercent).to.equal(0);
    expect(p95Delta?.status).to.equal("ok");
  });

  it("returns pass when regression is below threshold", () => {
    const baselineScenario = makeScenario();
    const currentScenario = makeScenario({
      aggregatedDurationPercentiles: {
        p50: 0.1,
        p75: 0.2,
        p90: 0.4,
        p95: 0.575, // +15%
        p99: 0.8,
      },
    });

    const report = compare(
      makeSnapshot([currentScenario]),
      makeBaseline([baselineScenario]),
    );

    expect(report.overallVerdict).to.equal("pass");
    const p95Delta = report.scenarios[0].deltas.find(
      (d) => d.metricName === "p95_latency",
    );
    expect(p95Delta?.deltaPercent).to.be.closeTo(15, 0.1);
    expect(p95Delta?.status).to.equal("ok");
  });

  it("returns fail when p95 regression exceeds threshold", () => {
    const baselineScenario = makeScenario();
    const currentScenario = makeScenario({
      aggregatedDurationPercentiles: {
        p50: 0.1,
        p75: 0.2,
        p90: 0.4,
        p95: 0.625, // +25%
        p99: 0.8,
      },
    });

    const report = compare(
      makeSnapshot([currentScenario]),
      makeBaseline([baselineScenario]),
    );

    expect(report.overallVerdict).to.equal("fail");
    expect(report.summary.failed).to.equal(1);
    expect(report.summary.regressions).to.have.length(1);
    expect(report.summary.regressions[0].metricName).to.equal("p95_latency");
  });

  it("marks improvement when latency decreases significantly", () => {
    const baselineScenario = makeScenario();
    const currentScenario = makeScenario({
      aggregatedDurationPercentiles: {
        p50: 0.1,
        p75: 0.2,
        p90: 0.4,
        p95: 0.35, // -30%
        p99: 0.8,
      },
    });

    const report = compare(
      makeSnapshot([currentScenario]),
      makeBaseline([baselineScenario]),
    );

    expect(report.overallVerdict).to.equal("pass");
    const p95Delta = report.scenarios[0].deltas.find(
      (d) => d.metricName === "p95_latency",
    );
    expect(p95Delta?.status).to.equal("improvement");
  });

  it("returns fail when error rate regression exceeds threshold", () => {
    const baselineScenario = makeScenario({ errorRate: 0.01 });
    const currentScenario = makeScenario({ errorRate: 0.15 }); // huge jump

    const report = compare(
      makeSnapshot([currentScenario]),
      makeBaseline([baselineScenario]),
    );

    expect(report.overallVerdict).to.equal("fail");
    const errorDelta = report.scenarios[0].deltas.find(
      (d) => d.metricName === "error_rate",
    );
    expect(errorDelta?.status).to.equal("regression");
  });

  it("applies per-scenario threshold overrides", () => {
    const baselineScenario = makeScenario();
    const currentScenario = makeScenario({
      aggregatedDurationPercentiles: {
        p50: 0.1,
        p75: 0.2,
        p90: 0.4,
        p95: 0.65, // +30%
        p99: 0.8,
      },
    });

    // With default threshold (20%), this would fail
    // But with override (50%), it passes
    const report = compare(
      makeSnapshot([currentScenario]),
      makeBaseline([baselineScenario]),
      {
        perScenario: {
          "Login:0": { maxIncreasePercent: 50 },
        },
      },
    );

    expect(report.overallVerdict).to.equal("pass");
  });

  it("skips new scenarios not present in baseline", () => {
    const baselineScenario = makeScenario({ scenario: "Login" });
    const newScenario = makeScenario({ scenario: "Checkout" });

    const report = compare(
      makeSnapshot([baselineScenario, newScenario]),
      makeBaseline([baselineScenario]),
    );

    // Only Login is compared, Checkout is listed as new
    expect(report.scenarios).to.have.length(1);
    expect(report.scenarios[0].scenario).to.equal("Login");
    expect(report.summary.newScenarios).to.deep.equal([
      { scenario: "Checkout", iteration: 0 },
    ]);
    expect(report.overallVerdict).to.equal("pass");
  });

  it("fails when scenario iterations of the baseline are missing", () => {
    const login0 = makeScenario({ iteration: 0 });
    const login1 = makeScenario({ iteration: 1 });

    const report = compare(
      makeSnapshot([login0]),
      makeBaseline([login0, login1]),
    );

    expect(report.summary.missingScenarios).to.deep.equal([
      { scenario: "Login", iteration: 1 },
    ]);
    expect(report.summary.failed).to.equal(0);
    expect(report.overallVerdict).to.equal("fail");
  });

  it("fails when nothing of the baseline ran", () => {
    const report = compare(
      makeSnapshot([makeScenario({ scenario: "Renamed" })]),
      makeBaseline([makeScenario()]),
    );

    expect(report.summary.totalScenarios).to.equal(0);
    expect(report.overallVerdict).to.equal("fail");
  });

  it("tells which scenario and iteration each regression comes from", () => {
    const slow = makeScenario({
      iteration: 2,
      aggregatedDurationPercentiles: {
        p50: 0.1,
        p75: 0.2,
        p90: 0.4,
        p95: 0.9,
        p99: 0.8,
      },
    });

    const report = compare(
      makeSnapshot([slow]),
      makeBaseline([makeScenario({ iteration: 2 })]),
    );

    expect(report.summary.regressions).to.have.length(1);
    expect(report.summary.regressions[0]).to.include({
      metricName: "p95_latency",
      scenario: "Login",
      iteration: 2,
    });
  });

  it("applies a per-scenario override to all its iterations, unless one is set for the iteration", () => {
    const base = [0, 1].map((iteration) => makeScenario({ iteration }));
    const current = [0, 1].map((iteration) =>
      makeScenario({
        iteration,
        aggregatedDurationPercentiles: {
          p50: 0.1,
          p75: 0.2,
          p90: 0.4,
          p95: 0.7, // +40%
          p99: 0.8,
        },
      }),
    );

    const report = compare(makeSnapshot(current), makeBaseline(base), {
      perScenario: {
        Login: { maxIncreasePercent: 50 },
        "Login:1": { maxIncreasePercent: 30 },
      },
    });

    expect(report.scenarios.map((s) => s.verdict)).to.deep.equal([
      "pass",
      "fail",
    ]);
  });

  it("does not compare values a baseline does not know (null)", () => {
    const baseline = makeBaseline([makeScenario()]);
    // A percentile without any sample is NaN in a snapshot, null once saved
    (
      baseline.snapshot.scenarios[0].aggregatedDurationPercentiles as {
        p95: number | null;
      }
    ).p95 = null;

    const report = compare(makeSnapshot([makeScenario()]), baseline);

    expect(report.scenarios[0].deltas.map((d) => d.metricName)).to.deep.equal([
      "p50_latency",
      "error_rate",
      "total_requests",
    ]);
    expect(report.overallVerdict).to.equal("pass");
  });

  it("fails overall when one of multiple scenarios fails", () => {
    const loginBaseline = makeScenario({ scenario: "Login" });
    const checkoutBaseline = makeScenario({ scenario: "Checkout" });

    const loginCurrent = makeScenario({ scenario: "Login" }); // unchanged
    const checkoutCurrent = makeScenario({
      scenario: "Checkout",
      aggregatedDurationPercentiles: {
        p50: 0.1,
        p75: 0.2,
        p90: 0.4,
        p95: 1.0, // +100%, regression
        p99: 0.8,
      },
    });

    const report = compare(
      makeSnapshot([loginCurrent, checkoutCurrent]),
      makeBaseline([loginBaseline, checkoutBaseline]),
    );

    expect(report.overallVerdict).to.equal("fail");
    expect(report.summary.passed).to.equal(1);
    expect(report.summary.failed).to.equal(1);
  });

  it("handles zero baseline values gracefully", () => {
    const baselineScenario = makeScenario({
      aggregatedDurationPercentiles: {
        p50: 0,
        p75: 0,
        p90: 0,
        p95: 0,
        p99: 0,
      },
    });
    const currentScenario = makeScenario({
      aggregatedDurationPercentiles: {
        p50: 0.1,
        p75: 0.2,
        p90: 0.4,
        p95: 0.5,
        p99: 0.8,
      },
    });

    const report = compare(
      makeSnapshot([currentScenario]),
      makeBaseline([baselineScenario]),
    );

    // Baseline was 0, current is non-zero → Infinity delta → regression
    expect(report.overallVerdict).to.equal("fail");
    const p95Delta = report.scenarios[0].deltas.find(
      (d) => d.metricName === "p95_latency",
    );
    expect(p95Delta?.deltaPercent).to.equal(Infinity);
    expect(p95Delta?.status).to.equal("regression");
  });

  it("handles both baseline and current being zero", () => {
    const scenario = makeScenario({
      aggregatedDurationPercentiles: {
        p50: 0,
        p75: 0,
        p90: 0,
        p95: 0,
        p99: 0,
      },
      errorRate: 0,
    });

    const report = compare(makeSnapshot([scenario]), makeBaseline([scenario]));

    expect(report.overallVerdict).to.equal("pass");
    const p95Delta = report.scenarios[0].deltas.find(
      (d) => d.metricName === "p95_latency",
    );
    expect(p95Delta?.deltaPercent).to.equal(0);
  });
});

function makeResources(
  browser: string,
  { cpu = 100, ramKb = 800_000 }: { cpu?: number; ramKb?: number } = {},
): ResourceMetrics {
  const percentiles = (p95: number) => ({
    p50: p95 / 2,
    p75: p95 * 0.75,
    p90: p95 * 0.9,
    p95,
    p99: p95,
  });
  return {
    browser,
    tabCpuPercentiles: percentiles(cpu / 2),
    tabRamKbPercentiles: percentiles(ramKb / 4),
    podCpuPercentiles: percentiles(cpu),
    podRamKbPercentiles: percentiles(ramKb),
    tabCpuMean: cpu / 4,
    tabRamKbMean: ramKb / 8,
    podCpuMean: cpu / 2,
    podRamKbMean: ramKb / 2,
  };
}

function withResources(
  snapshot: RunSnapshot,
  resources: ResourceMetrics[],
): RunSnapshot {
  return { ...snapshot, resources };
}

describe("compare resources", () => {
  const scenario = makeScenario();

  it("passes when the browsers consume as much as in the baseline", () => {
    const baseline = makeBaseline([scenario]);
    baseline.snapshot.resources = [
      makeResources("chrome"),
      makeResources("firefox"),
    ];

    const report = compare(
      withResources(makeSnapshot([scenario]), [
        makeResources("chrome", { cpu: 110 }),
        makeResources("firefox"),
      ]),
      baseline,
    );

    expect(report.overallVerdict).to.equal("pass");
    expect(report.resources.map((r) => r.browser)).to.deep.equal([
      "chrome",
      "firefox",
    ]);
    expect(report.resources[0].deltas.map((d) => d.metricName)).to.deep.equal([
      "mean_browser_cpu_percent",
      "mean_browser_ram_kb",
      "mean_tab_cpu_percent",
      "mean_tab_ram_kb",
    ]);
  });

  it("fails when a browser uses more memory than allowed, and says which", () => {
    const baseline = makeBaseline([scenario]);
    baseline.snapshot.resources = [makeResources("firefox")];

    const report = compare(
      withResources(makeSnapshot([scenario]), [
        makeResources("firefox", { ramKb: 1_200_000 }), // +50%
      ]),
      baseline,
    );

    expect(report.overallVerdict).to.equal("fail");
    expect(report.summary.failed).to.equal(0);
    expect(report.resources[0].verdict).to.equal("fail");
    expect(
      report.summary.regressions.map((r) => [r.browser, r.metricName]),
    ).to.deep.equal([
      ["firefox", "mean_browser_ram_kb"],
      ["firefox", "mean_tab_ram_kb"],
    ]);
  });

  it("uses defaultMaxResourceIncreasePercent", () => {
    const baseline = makeBaseline([scenario]);
    baseline.snapshot.resources = [makeResources("firefox")];

    const report = compare(
      withResources(makeSnapshot([scenario]), [
        makeResources("firefox", { cpu: 140 }), // +40%
      ]),
      baseline,
      { defaultMaxResourceIncreasePercent: 50 },
    );

    expect(report.overallVerdict).to.equal("pass");
  });

  it("lists the browsers measured in the baseline only, without failing", () => {
    // e.g. the current run is on macOS, where Kyara does not measure the browsers
    const baseline = makeBaseline([scenario]);
    baseline.snapshot.resources = [makeResources("firefox")];

    const report = compare(makeSnapshot([scenario]), baseline);

    expect(report.resources).to.deep.equal([]);
    expect(report.summary.missingBrowsers).to.deep.equal(["firefox"]);
    expect(report.overallVerdict).to.equal("pass");
  });

  it("skips a metric without samples (no tab measured)", () => {
    const baseline = makeBaseline([scenario]);
    const noTab = makeResources("chrome");
    noTab.tabCpuMean = NaN;
    baseline.snapshot.resources = [noTab];

    const report = compare(
      withResources(makeSnapshot([scenario]), [makeResources("chrome")]),
      baseline,
    );

    expect(report.resources[0].deltas.map((d) => d.metricName)).to.not.include(
      "mean_tab_cpu_percent",
    );
    expect(report.overallVerdict).to.equal("pass");
  });

  it("compares the means, not the percentiles of the coarse buckets", () => {
    const baseline = makeBaseline([scenario]);
    baseline.snapshot.resources = [makeResources("firefox")];
    // Same consumption, but the p95 moved to the next CPU bucket
    const current = makeResources("firefox");
    current.podCpuPercentiles.p95 *= 2;

    const report = compare(
      withResources(makeSnapshot([scenario]), [current]),
      baseline,
    );

    expect(report.overallVerdict).to.equal("pass");
  });

  it("does not compare the means of a baseline saved by hikaku 0.2", () => {
    const baseline = makeBaseline([scenario]);
    const old: Partial<ResourceMetrics> = makeResources("firefox");
    delete old.podCpuMean;
    delete old.podRamKbMean;
    delete old.tabCpuMean;
    delete old.tabRamKbMean;
    baseline.snapshot.resources = [old as ResourceMetrics];

    const report = compare(
      withResources(makeSnapshot([scenario]), [
        makeResources("firefox", { cpu: 500 }),
      ]),
      baseline,
    );

    expect(report.resources[0].deltas).to.deep.equal([]);
    expect(report.overallVerdict).to.equal("pass");
  });
});
