const TOKEN_INPUT_KEYS = [
  "ai.usage.inputTokens",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.prompt_tokens",
  "llm.token_count.prompt",
];

const TOKEN_OUTPUT_KEYS = [
  "ai.usage.outputTokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.completion_tokens",
  "llm.token_count.completion",
];

const MODEL_NAME_KEYS = [
  "ai.model.id",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "llm.model_name",
];

const AVG_COMPLETION_TOKENS_PER_SECOND_KEYS = [
  "ai.response.avgCompletionTokensPerSecond",
];

function toOptionalInt(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function toOptionalFloat(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function extractInputTokens(attrs: Record<string, unknown>): number | null {
  for (const key of TOKEN_INPUT_KEYS) {
    const value = toOptionalInt(attrs[key]);
    if (value != null) return value;
  }
  return null;
}

export function extractOutputTokens(attrs: Record<string, unknown>): number | null {
  for (const key of TOKEN_OUTPUT_KEYS) {
    const value = toOptionalInt(attrs[key]);
    if (value != null) return value;
  }
  return null;
}

export function extractModelName(attrs: Record<string, unknown>): string | null {
  for (const key of MODEL_NAME_KEYS) {
    const value = attrs[key];
    if (value != null) return String(value);
  }
  return null;
}

export function extractTps(
  attrs: Record<string, unknown>,
  durationMs: number | null,
  outputTokens: number | null,
): number | null {
  for (const key of AVG_COMPLETION_TOKENS_PER_SECOND_KEYS) {
    const value = toOptionalFloat(attrs[key]);
    if (value != null) return value;
  }

  if (!durationMs || durationMs <= 0 || !outputTokens || outputTokens <= 0) {
    return null;
  }
  return outputTokens / (durationMs / 1000);
}
