import type {
  ComparisonReport,
  RunSnapshot,
  Baseline,
  ReportOptions,
  LlmProvider,
} from "./types.js";

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

/** Default model of `createAnthropicProvider` */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

/**
 * Create an LLM provider using the Anthropic SDK.
 *
 * Requires `@anthropic-ai/sdk` to be installed (optional peer dependency). The SDK reads
 * `ANTHROPIC_BASE_URL` to reach a proxy or a gateway.
 *
 * @param apiKey - Anthropic API key
 * @param model - Model name. Default: `DEFAULT_ANTHROPIC_MODEL` (`claude-sonnet-5-5`)
 * @returns An LlmProvider instance, which rejects when the model returns no text
 */
export function createAnthropicProvider(
  apiKey: string,
  model: string = DEFAULT_ANTHROPIC_MODEL,
): LlmProvider {
  return {
    async complete(systemPrompt: string, userMessage: string): Promise<string> {
      // Dynamic import to avoid hard dependency on @anthropic-ai/sdk
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      // Streamed: the snapshots can make a long input. The model may think before writing
      // the report: max_tokens covers both.
      const response = await client.messages
        .stream({
          model,
          max_tokens: 16000,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        })
        .finalMessage();

      if (response.stop_reason === "refusal") {
        throw new Error(`${model} declined to write the report`);
      }
      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
      if (!text) {
        throw new Error(
          `${model} returned no report (stop reason: ${response.stop_reason})`,
        );
      }
      return text;
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
- If browsers regressed in CPU or memory, say which browser, which metric and by how much.
- If scenarios of the baseline are missing from the current run, list them: the runs are not comparable and the verdict fails until the baseline is updated.
- For stable or improved scenarios, provide a brief one-line summary.
- Keep the report concise: no more than 300 words.
- Use metric names that are human-readable (e.g., "p95 latency" instead of "p95_latency").
- Express latency values in milliseconds (multiply seconds by 1000 if needed).
- Express error rates as percentages.
- CPU values are in % of one core (a browser can use several cores); memory values are in kB (proportional set size): express them in MB.
- A deltaPercent of "Infinity" means the baseline value was 0.
- Do not invent data that is not present in the input.`;
}

/** Compact JSON (fewer tokens); Infinity would otherwise become null */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : v,
  );
}

function buildUserMessage(
  report: ComparisonReport,
  current: RunSnapshot,
  baseline: Baseline,
): string {
  return `Here is the performance comparison data to analyze (JSON).

## Comparison Report
${toJson(report)}

## Current Run Snapshot
${toJson(current)}

## Baseline Snapshot
${toJson(baseline.snapshot)}

Baseline created at: ${baseline.createdAt}
Current run at: ${current.timestamp}

Please generate a performance analysis report.`;
}
