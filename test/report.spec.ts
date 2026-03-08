import { expect } from "chai";
import { generateReport } from "../src/report";
import type {
  ComparisonReport,
  RunSnapshot,
  Baseline,
  LlmProvider,
  ScenarioMetrics,
} from "../src/types";

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

function makeReport(verdict: "pass" | "fail" = "fail"): ComparisonReport {
  return {
    timestamp: "2026-03-08T12:05:00.000Z",
    overallVerdict: verdict,
    scenarios: [
      {
        scenario: "Login",
        iteration: 0,
        deltas: [
          {
            metricName: "p95_latency",
            baselineValue: 0.5,
            currentValue: 0.75,
            deltaPercent: 50,
            status: "regression",
          },
          {
            metricName: "error_rate",
            baselineValue: 0.01,
            currentValue: 0.01,
            deltaPercent: 0,
            status: "ok",
          },
        ],
        verdict: "fail",
      },
    ],
    summary: {
      totalScenarios: 1,
      passed: 0,
      failed: 1,
      regressions: [
        {
          metricName: "p95_latency",
          baselineValue: 0.5,
          currentValue: 0.75,
          deltaPercent: 50,
          status: "regression",
        },
      ],
    },
  };
}

/** Creates a mock LlmProvider that captures the prompts and returns a canned response */
function createMockProvider(response: string = "Mock report output"): {
  provider: LlmProvider;
  calls: Array<{ systemPrompt: string; userMessage: string }>;
} {
  const calls: Array<{ systemPrompt: string; userMessage: string }> = [];
  const provider: LlmProvider = {
    async complete(systemPrompt: string, userMessage: string): Promise<string> {
      calls.push({ systemPrompt, userMessage });
      return response;
    },
  };
  return { provider, calls };
}

describe("generateReport", () => {
  it("calls the LLM provider with system prompt and user message", async () => {
    const { provider, calls } = createMockProvider();
    const report = makeReport();
    const current = makeSnapshot([makeScenario()]);
    const baseline = makeBaseline([makeScenario()]);

    const result = await generateReport(report, current, baseline, {
      provider,
    });

    expect(result).to.equal("Mock report output");
    expect(calls).to.have.length(1);
    expect(calls[0].systemPrompt).to.include("performance engineering");
    expect(calls[0].userMessage).to.include("Comparison Report");
  });

  it("includes the comparison report JSON in user message", async () => {
    const { provider, calls } = createMockProvider();
    const report = makeReport();
    const current = makeSnapshot([makeScenario()]);
    const baseline = makeBaseline([makeScenario()]);

    await generateReport(report, current, baseline, { provider });

    expect(calls[0].userMessage).to.include("p95_latency");
    expect(calls[0].userMessage).to.include('"deltaPercent": 50');
    expect(calls[0].userMessage).to.include('"overallVerdict": "fail"');
  });

  it("includes current and baseline snapshots in user message", async () => {
    const { provider, calls } = createMockProvider();
    const report = makeReport();
    const current = makeSnapshot([makeScenario()]);
    const baseline = makeBaseline([makeScenario()]);

    await generateReport(report, current, baseline, { provider });

    expect(calls[0].userMessage).to.include("Current Run Snapshot");
    expect(calls[0].userMessage).to.include("Baseline Snapshot");
    expect(calls[0].userMessage).to.include("2026-03-07T12:00:00.000Z");
    expect(calls[0].userMessage).to.include("2026-03-08T12:00:00.000Z");
  });

  it("defaults to English, markdown, with recommendations", async () => {
    const { provider, calls } = createMockProvider();
    const report = makeReport();
    const current = makeSnapshot([makeScenario()]);
    const baseline = makeBaseline([makeScenario()]);

    await generateReport(report, current, baseline, { provider });

    expect(calls[0].systemPrompt).to.include("English");
    expect(calls[0].systemPrompt).to.include("Markdown");
    expect(calls[0].systemPrompt).to.include("Recommendations");
  });

  it("respects locale=fr option", async () => {
    const { provider, calls } = createMockProvider();
    const report = makeReport();
    const current = makeSnapshot([makeScenario()]);
    const baseline = makeBaseline([makeScenario()]);

    await generateReport(report, current, baseline, { provider, locale: "fr" });

    expect(calls[0].systemPrompt).to.include("French");
  });

  it("respects format=text option", async () => {
    const { provider, calls } = createMockProvider();
    const report = makeReport();
    const current = makeSnapshot([makeScenario()]);
    const baseline = makeBaseline([makeScenario()]);

    await generateReport(report, current, baseline, {
      provider,
      format: "text",
    });

    expect(calls[0].systemPrompt).to.include("plain text");
    expect(calls[0].systemPrompt).to.not.include(
      "Format your response as Markdown",
    );
  });

  it("respects includeRecommendations=false option", async () => {
    const { provider, calls } = createMockProvider();
    const report = makeReport();
    const current = makeSnapshot([makeScenario()]);
    const baseline = makeBaseline([makeScenario()]);

    await generateReport(report, current, baseline, {
      provider,
      includeRecommendations: false,
    });

    expect(calls[0].systemPrompt).to.include("Do not include recommendations");
  });

  it("returns the LLM response as-is", async () => {
    const expectedReport = "## Performance Report\n\nAll good!";
    const { provider } = createMockProvider(expectedReport);
    const report = makeReport("pass");
    const current = makeSnapshot([makeScenario()]);
    const baseline = makeBaseline([makeScenario()]);

    const result = await generateReport(report, current, baseline, {
      provider,
    });

    expect(result).to.equal(expectedReport);
  });

  it("handles empty scenarios gracefully", async () => {
    const { provider, calls } = createMockProvider();
    const report: ComparisonReport = {
      timestamp: "2026-03-08T12:05:00.000Z",
      overallVerdict: "pass",
      scenarios: [],
      summary: { totalScenarios: 0, passed: 0, failed: 0, regressions: [] },
    };
    const current = makeSnapshot([]);
    const baseline = makeBaseline([]);

    const result = await generateReport(report, current, baseline, {
      provider,
    });

    expect(result).to.equal("Mock report output");
    expect(calls).to.have.length(1);
  });
});
