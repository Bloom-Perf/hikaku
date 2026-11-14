import { expect } from "chai";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  generateReport,
} from "../src/report.js";
import type {
  ComparisonReport,
  RunSnapshot,
  Baseline,
  LlmProvider,
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
    resources: [],
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
          scenario: "Login",
          iteration: 0,
        },
      ],
      missingScenarios: [],
      newScenarios: [],
      missingBrowsers: [],
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
    expect(calls[0].userMessage).to.include('"deltaPercent":50');
    expect(calls[0].userMessage).to.include('"overallVerdict":"fail"');
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
      resources: [],
      summary: {
        totalScenarios: 0,
        passed: 0,
        failed: 0,
        regressions: [],
        missingScenarios: [],
        newScenarios: [],
        missingBrowsers: [],
      },
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

describe("generateReport input", () => {
  it("keeps infinite deltas (baseline value 0) in the JSON", async () => {
    const { provider, calls } = createMockProvider();
    const report = makeReport();
    report.scenarios[0].deltas[1] = {
      metricName: "error_rate",
      baselineValue: 0,
      currentValue: 0.05,
      deltaPercent: Infinity,
      status: "regression",
    };

    await generateReport(
      report,
      makeSnapshot([makeScenario()]),
      makeBaseline([makeScenario()]),
      { provider },
    );

    expect(calls[0].userMessage).to.include('"deltaPercent":"Infinity"');
    expect(calls[0].systemPrompt).to.include("Infinity");
  });

  it("explains the resource metrics and the missing scenarios", async () => {
    const { provider, calls } = createMockProvider();

    await generateReport(
      makeReport(),
      makeSnapshot([makeScenario()]),
      makeBaseline([makeScenario()]),
      { provider },
    );

    expect(calls[0].systemPrompt).to.include("% of one core");
    expect(calls[0].systemPrompt).to.include("missing from the current run");
  });
});

/** Answers the Messages API with a stream (server-sent events) */
function sseBody(text: string, stopReason: string): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: DEFAULT_ANTHROPIC_MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

describe("createAnthropicProvider", () => {
  let server: Server;
  let requests: Array<Record<string, unknown>>;
  let reply: { text: string; stopReason: string };
  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseBody(reply.text, reply.stopReason));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    requests = [];
    reply = { text: "## Report", stopReason: "end_turn" };
  });

  it("streams a message from the default model and returns its text", async () => {
    const provider = createAnthropicProvider("test-key");

    const text = await provider.complete("system prompt", "user message");

    expect(text).to.equal("## Report");
    expect(requests).to.have.length(1);
    expect(requests[0]).to.include({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      stream: true,
      system: "system prompt",
    });
    expect(requests[0].messages).to.deep.equal([
      { role: "user", content: "user message" },
    ]);
  });

  it("uses the given model", async () => {
    await createAnthropicProvider("test-key", "claude-opus-5-5").complete(
      "s",
      "u",
    );

    expect(requests[0].model).to.equal("claude-opus-5-5");
  });

  it("rejects when the model declines", async () => {
    reply = { text: "", stopReason: "refusal" };

    let error: unknown;
    try {
      await createAnthropicProvider("test-key").complete("s", "u");
    } catch (e) {
      error = e;
    }

    expect(String(error)).to.include("declined to write the report");
  });

  it("rejects when the model returns no text", async () => {
    reply = { text: "  ", stopReason: "max_tokens" };

    let error: unknown;
    try {
      await createAnthropicProvider("test-key").complete("s", "u");
    } catch (e) {
      error = e;
    }

    expect(String(error)).to.include(
      "returned no report (stop reason: max_tokens)",
    );
  });
});
