import type {
  ComparisonReport,
  RunSnapshot,
  Baseline,
  ReportOptions,
  LlmProvider,
} from "./types";

/**
 * Generate a natural language performance report from a ComparisonReport using an LLM.
 *
 * @param report - The comparison report from compare()
 * @param current - The current run snapshot
 * @param baseline - The baseline used for comparison
 * @param options - LLM provider and formatting options
 * @returns A human-readable report string (markdown or plain text)
 */
export async function generateReport(
  report: ComparisonReport,
  current: RunSnapshot,
  baseline: Baseline,
  options: ReportOptions,
): Promise<string> {
  const locale = options.locale ?? "en";
  const format = options.format ?? "markdown";
  const includeRecommendations = options.includeRecommendations ?? true;

  const systemPrompt = buildSystemPrompt(
    locale,
    format,
    includeRecommendations,
  );
  const userMessage = buildUserMessage(report, current, baseline);

  return options.provider.complete(systemPrompt, userMessage);
}

/**
 * Create an LLM provider using the Anthropic SDK.
 *
 * Requires `@anthropic-ai/sdk` to be installed as a peer dependency.
 *
 * @param apiKey - Anthropic API key
 * @param model - Model name. Default: 'claude-sonnet-4-20250514'
 * @returns An LlmProvider instance
 */
export function createAnthropicProvider(
  apiKey: string,
  model?: string,
): LlmProvider {
  const modelId = model ?? "claude-sonnet-4-20250514";

  return {
    async complete(systemPrompt: string, userMessage: string): Promise<string> {
      // Dynamic import to avoid hard dependency on @anthropic-ai/sdk
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      const response = await client.messages.create({
        model: modelId,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock ? textBlock.text : "";
    },
  };
}

// ============ Internal: prompt construction ============

function buildSystemPrompt(
  locale: "en" | "fr",
  format: "markdown" | "text",
  includeRecommendations: boolean,
): string {
  const lang = locale === "fr" ? "French" : "English";
  const formatInstr =
    format === "markdown"
      ? "Format your response as Markdown with headers, bullet points, and bold text for emphasis."
      : "Format your response as plain text without any Markdown syntax.";

  const recoInstr = includeRecommendations
    ? 'Include a brief "Recommendations" section with actionable investigation suggestions based on the regressions observed.'
    : "Do not include recommendations or investigation suggestions.";

  return `You are a performance engineering expert analyzing load test results.
You produce concise, actionable performance reports.

Rules:
- Write in ${lang}.
- ${formatInstr}
- ${recoInstr}
- Start with a one-line summary indicating the overall verdict (pass/fail) and the number of scenarios tested.
- For each scenario with a regression, explain what degraded, by how much (percentage and absolute values), and its potential impact.
- For stable or improved scenarios, provide a brief one-line summary.
- Keep the report concise: no more than 300 words.
- Use metric names that are human-readable (e.g., "p95 latency" instead of "p95_latency").
- Express latency values in milliseconds (multiply seconds by 1000 if needed).
- Express error rates as percentages.
- Do not invent data that is not present in the input.`;
}

function buildUserMessage(
  report: ComparisonReport,
  current: RunSnapshot,
  baseline: Baseline,
): string {
  return `Here is the performance comparison data to analyze:

## Comparison Report
${JSON.stringify(report, null, 2)}

## Current Run Snapshot
${JSON.stringify(current, null, 2)}

## Baseline Snapshot
${JSON.stringify(baseline.snapshot, null, 2)}

Baseline created at: ${baseline.createdAt}
Current run at: ${current.timestamp}

Please generate a performance analysis report.`;
}
