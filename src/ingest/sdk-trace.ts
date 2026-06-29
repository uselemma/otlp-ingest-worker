import type { Env } from '../config';
import {
  LEMMA_TRACE_PAYLOAD_FORMAT,
  LEMMA_TRACE_PAYLOAD_VERSION,
  type LemmaIngestSpan,
  type LemmaTracePayload,
} from '../otel/lemma-trace-payload';
import {
  enqueueLemmaTracePayload,
  OtlpHttpTraceError,
} from '../pipeline/run-standard-ingest';

type SdkUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

type SdkSpan = {
  id?: string;
  parent_id?: string | null;
  name: string;
  type?: 'span' | 'generation' | 'tool';
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  input_mime_type?: string;
  output_mime_type?: string;
  llm_model_name?: string;
  llm_provider?: string;
  llm_system?: string;
  llm_invocation_parameters?: unknown;
  llm_input_messages?: unknown[];
  llm_output_messages?: unknown[];
  llm_tools?: unknown;
  llm_token_count_prompt?: number;
  llm_token_count_completion?: number;
  llm_token_count_total?: number;
  llm_prompt_template?: string;
  llm_prompt_template_variables?: unknown;
  llm_prompt_template_version?: string;
  tool_description?: string;
  tool_parameters?: unknown;
  retrieval_documents?: unknown[];
  embedding_model_name?: string;
  embedding_invocation_parameters?: unknown;
  embedding_embeddings?: unknown;
  reranker_model_name?: string;
  reranker_input_documents?: unknown[];
  reranker_output_documents?: unknown[];
  started_at?: string;
  ended_at?: string | null;
  duration_ms?: number | null;
  status?: 'OK' | 'ERROR';
  error?: string | null;
  model?: string | null;
  usage?: SdkUsage;
  tool_name?: string | null;
};

type SdkTraceInput = {
  project_id: string;
  trace: {
    id?: string;
    name: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    thread_id?: string | null;
    user_id?: string | null;
    environment?: string | null;
    started_at?: string;
    ended_at?: string | null;
    duration_ms?: number | null;
    status?: 'OK' | 'ERROR';
    error?: string | null;
    spans?: SdkSpan[];
  };
};

const NS_PER_MS = 1_000_000;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildJsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OtlpHttpTraceError(400, 'Invalid SDK trace payload');
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OtlpHttpTraceError(400, `${field} is required`);
  }
  return value;
}

function assertUuid(value: unknown, field: string): string {
  const id = assertString(value, field);
  if (!UUID_REGEX.test(id)) {
    throw new OtlpHttpTraceError(400, `${field} must be a UUID`);
  }
  return id;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseSdkTraceInput(value: unknown): SdkTraceInput {
  const body = assertRecord(value);
  const projectId = assertUuid(body.project_id, 'project_id');
  const traceRaw = assertRecord(body.trace);
  const spansRaw = Array.isArray(traceRaw.spans) ? traceRaw.spans : [];

  return {
    project_id: projectId,
    trace: {
      id: optionalString(traceRaw.id),
      name: assertString(traceRaw.name, 'trace.name'),
      input: traceRaw.input,
      output: traceRaw.output,
      metadata: optionalRecord(traceRaw.metadata),
      thread_id:
        typeof traceRaw.thread_id === 'string' || traceRaw.thread_id === null
          ? traceRaw.thread_id
          : undefined,
      user_id:
        typeof traceRaw.user_id === 'string' || traceRaw.user_id === null
          ? traceRaw.user_id
          : undefined,
      environment:
        typeof traceRaw.environment === 'string' ||
        traceRaw.environment === null
          ? traceRaw.environment
          : undefined,
      started_at: optionalString(traceRaw.started_at),
      ended_at:
        typeof traceRaw.ended_at === 'string' || traceRaw.ended_at === null
          ? traceRaw.ended_at
          : undefined,
      duration_ms:
        typeof traceRaw.duration_ms === 'number' ||
        traceRaw.duration_ms === null
          ? traceRaw.duration_ms
          : undefined,
      status:
        traceRaw.status === 'ERROR' || traceRaw.status === 'OK'
          ? traceRaw.status
          : undefined,
      error:
        typeof traceRaw.error === 'string' || traceRaw.error === null
          ? traceRaw.error
          : undefined,
      spans: spansRaw.map(parseSdkSpan),
    },
  };
}

function parseSdkSpan(value: unknown): SdkSpan {
  const raw = assertRecord(value);
  const type =
    raw.type === 'generation' || raw.type === 'tool' || raw.type === 'span'
      ? raw.type
      : 'span';
  const usageRaw = optionalRecord(raw.usage);
  return {
    id: optionalString(raw.id),
    parent_id:
      typeof raw.parent_id === 'string' || raw.parent_id === null
        ? raw.parent_id
        : undefined,
    name: assertString(raw.name, 'span.name'),
    type,
    input: raw.input,
    output: raw.output,
    metadata: optionalRecord(raw.metadata),
    attributes: optionalRecord(raw.attributes),
    input_mime_type: optionalString(raw.input_mime_type),
    output_mime_type: optionalString(raw.output_mime_type),
    llm_model_name: optionalString(raw.llm_model_name),
    llm_provider: optionalString(raw.llm_provider),
    llm_system: optionalString(raw.llm_system),
    llm_invocation_parameters: raw.llm_invocation_parameters,
    llm_input_messages: optionalArray(raw.llm_input_messages),
    llm_output_messages: optionalArray(raw.llm_output_messages),
    llm_tools: raw.llm_tools,
    llm_token_count_prompt: optionalNumber(raw.llm_token_count_prompt),
    llm_token_count_completion: optionalNumber(raw.llm_token_count_completion),
    llm_token_count_total: optionalNumber(raw.llm_token_count_total),
    llm_prompt_template: optionalString(raw.llm_prompt_template),
    llm_prompt_template_variables: raw.llm_prompt_template_variables,
    llm_prompt_template_version: optionalString(
      raw.llm_prompt_template_version
    ),
    tool_description: optionalString(raw.tool_description),
    tool_parameters: raw.tool_parameters,
    retrieval_documents: optionalArray(raw.retrieval_documents),
    embedding_model_name: optionalString(raw.embedding_model_name),
    embedding_invocation_parameters: raw.embedding_invocation_parameters,
    embedding_embeddings: raw.embedding_embeddings,
    reranker_model_name: optionalString(raw.reranker_model_name),
    reranker_input_documents: optionalArray(raw.reranker_input_documents),
    reranker_output_documents: optionalArray(raw.reranker_output_documents),
    started_at: optionalString(raw.started_at),
    ended_at:
      typeof raw.ended_at === 'string' || raw.ended_at === null
        ? raw.ended_at
        : undefined,
    duration_ms:
      typeof raw.duration_ms === 'number' || raw.duration_ms === null
        ? raw.duration_ms
        : undefined,
    status:
      raw.status === 'ERROR' || raw.status === 'OK' ? raw.status : undefined,
    error:
      typeof raw.error === 'string' || raw.error === null
        ? raw.error
        : undefined,
    model:
      typeof raw.model === 'string' || raw.model === null
        ? raw.model
        : undefined,
    usage: usageRaw
      ? {
          input_tokens: optionalNumber(usageRaw.input_tokens),
          output_tokens: optionalNumber(usageRaw.output_tokens),
        }
      : undefined,
    tool_name:
      typeof raw.tool_name === 'string' || raw.tool_name === null
        ? raw.tool_name
        : undefined,
  };
}

function timestamp(value: string | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function ns(date: Date): number {
  return date.getTime() * NS_PER_MS;
}

function explicitDurationMs(value: number | null | undefined): number | null {
  return value == null ? null : Math.max(0, value);
}

function durationMs(start: Date, end: Date | null): number | null {
  return end ? Math.max(0, end.getTime() - start.getTime()) : null;
}

function serializeAttribute(value: unknown): unknown {
  if (value == null) return value;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function addDefined(
  attributes: Record<string, unknown>,
  key: string,
  value: unknown
) {
  if (value !== undefined) attributes[key] = value;
}

function flattenObject(
  attributes: Record<string, unknown>,
  prefix: string,
  label: string,
  value: unknown
) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      addDefined(
        attributes,
        `${prefix}.${label}.${key}`,
        serializeAttribute(child)
      );
    }
    return;
  }
  addDefined(
    attributes,
    `${prefix}.${label}.content`,
    serializeAttribute(value)
  );
}

function baseAttributes(params: {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  error?: string | null;
}) {
  const attrs: Record<string, unknown> = {
    ...(params.metadata ?? {}),
    ...(params.attributes ?? {}),
  };
  if ('input' in params) attrs['input.value'] = params.input;
  if ('output' in params) attrs['output.value'] = params.output;
  if (params.error) attrs['error.message'] = params.error;
  return attrs;
}

function contractAttributes(span: SdkSpan): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  addDefined(attributes, 'input.mime_type', span.input_mime_type);
  addDefined(attributes, 'output.mime_type', span.output_mime_type);
  addDefined(attributes, 'llm.model_name', span.llm_model_name ?? span.model);
  addDefined(attributes, 'llm.provider', span.llm_provider);
  addDefined(attributes, 'llm.system', span.llm_system);
  addDefined(
    attributes,
    'llm.invocation_parameters',
    serializeAttribute(span.llm_invocation_parameters)
  );
  addDefined(attributes, 'llm.tools', serializeAttribute(span.llm_tools));
  addDefined(
    attributes,
    'llm.token_count.prompt',
    span.llm_token_count_prompt ?? span.usage?.input_tokens
  );
  addDefined(
    attributes,
    'llm.token_count.completion',
    span.llm_token_count_completion ?? span.usage?.output_tokens
  );
  addDefined(attributes, 'llm.token_count.total', span.llm_token_count_total);
  addDefined(
    attributes,
    'llm.prompt_template.template',
    span.llm_prompt_template
  );
  addDefined(
    attributes,
    'llm.prompt_template.variables',
    serializeAttribute(span.llm_prompt_template_variables)
  );
  addDefined(
    attributes,
    'llm.prompt_template.version',
    span.llm_prompt_template_version
  );
  addDefined(attributes, 'tool.description', span.tool_description);
  addDefined(
    attributes,
    'tool.parameters',
    serializeAttribute(span.tool_parameters)
  );
  addDefined(attributes, 'embedding.model_name', span.embedding_model_name);
  addDefined(
    attributes,
    'embedding.invocation_parameters',
    serializeAttribute(span.embedding_invocation_parameters)
  );
  addDefined(
    attributes,
    'embedding.embeddings',
    serializeAttribute(span.embedding_embeddings)
  );
  addDefined(attributes, 'reranker.model_name', span.reranker_model_name);

  span.llm_input_messages?.forEach((message, index) => {
    flattenObject(
      attributes,
      `llm.input_messages.${index}`,
      'message',
      message
    );
  });
  span.llm_output_messages?.forEach((message, index) => {
    flattenObject(
      attributes,
      `llm.output_messages.${index}`,
      'message',
      message
    );
  });
  span.retrieval_documents?.forEach((document, index) => {
    flattenObject(
      attributes,
      `retrieval.documents.${index}`,
      'document',
      document
    );
  });
  span.reranker_input_documents?.forEach((document, index) => {
    flattenObject(
      attributes,
      `reranker.input_documents.${index}`,
      'document',
      document
    );
  });
  span.reranker_output_documents?.forEach((document, index) => {
    flattenObject(
      attributes,
      `reranker.output_documents.${index}`,
      'document',
      document
    );
  });

  return attributes;
}

function statusCode(status: 'OK' | 'ERROR' | undefined, error?: string | null) {
  return status === 'ERROR' || error ? 'ERROR' : null;
}

function normalizeSpanId(
  spanId: string | undefined,
  used: Set<string>
): string {
  const id = spanId?.trim() || crypto.randomUUID();
  if (used.has(id)) {
    throw new OtlpHttpTraceError(400, `Duplicate span id "${id}"`);
  }
  used.add(id);
  return id;
}

function assignMissingChildDurations(
  rootSpan: LemmaIngestSpan,
  spans: LemmaIngestSpan[]
) {
  const spansByParent = new Map<string, LemmaIngestSpan[]>();
  for (const span of spans) {
    if (!span.parent_otel_span_id) continue;
    const siblings = spansByParent.get(span.parent_otel_span_id) ?? [];
    siblings.push(span);
    spansByParent.set(span.parent_otel_span_id, siblings);
  }

  const spansById = new Map<string, LemmaIngestSpan>([
    [rootSpan.otel_span_id, rootSpan],
    ...spans.map(span => [span.otel_span_id, span] as const),
  ]);
  const queue = [rootSpan.otel_span_id];

  while (queue.length > 0) {
    const parentId = queue.shift();
    if (!parentId) continue;

    const parent = spansById.get(parentId);
    const siblings = spansByParent.get(parentId) ?? [];
    if (!parent || siblings.length === 0) continue;

    if (parent.duration_ms != null) {
      const claimedDurationMs = siblings.reduce(
        (total, span) => total + (span.duration_ms ?? 0),
        0
      );
      const unclaimedDurationMs = Math.max(
        0,
        parent.duration_ms - claimedDurationMs
      );
      const missingDurationSiblings = siblings.filter(
        span => span.duration_ms == null
      );
      if (missingDurationSiblings.length > 0) {
        const inferredDurationMs =
          unclaimedDurationMs / missingDurationSiblings.length;
        for (const span of missingDurationSiblings) {
          span.duration_ms = inferredDurationMs;
        }
      }
    }

    for (const span of siblings) {
      queue.push(span.otel_span_id);
    }
  }
}

function buildSdkTracePayload(
  input: SdkTraceInput,
  producedAt: string
): LemmaTracePayload {
  const now = new Date();
  const traceStart = timestamp(input.trace.started_at, now);
  const traceEnd = input.trace.ended_at
    ? timestamp(input.trace.ended_at, now)
    : null;
  const traceId = input.trace.id ?? crypto.randomUUID();
  const rootSpanId = `${traceId}:root`;
  const usedSpanIds = new Set<string>([rootSpanId]);
  const rootAttributes = {
    ...baseAttributes({
      input: input.trace.input,
      output: input.trace.output,
      metadata: input.trace.metadata,
      error: input.trace.error,
    }),
    'gen_ai.agent.name': input.trace.name,
    'ai.agent.name': input.trace.name,
    ...(input.trace.thread_id
      ? { 'lemma.thread_id': input.trace.thread_id }
      : {}),
    ...(input.trace.user_id
      ? { 'user.id': input.trace.user_id, 'enduser.id': input.trace.user_id }
      : {}),
    ...('input' in input.trace ? { 'ai.agent.input': input.trace.input } : {}),
    ...('output' in input.trace
      ? {
          'ai.agent.output': input.trace.output,
          ...(typeof input.trace.output === 'string'
            ? { 'ai.response.text': input.trace.output }
            : {}),
        }
      : {}),
  };

  const rootSpan: LemmaIngestSpan = {
    trace_id_hex: traceId,
    otel_span_id: rootSpanId,
    parent_otel_span_id: null,
    name: input.trace.name,
    kind: 'span',
    start_time_ns: ns(traceStart),
    end_time_ns: traceEnd ? ns(traceEnd) : null,
    duration_ms:
      explicitDurationMs(input.trace.duration_ms) ??
      durationMs(traceStart, traceEnd),
    status_code: statusCode(input.trace.status, input.trace.error),
    status_description: input.trace.error ?? null,
    attributes: rootAttributes,
    events: [],
    resource: {},
    input_tokens: null,
    output_tokens: null,
    model_name: null,
    tps: null,
  };

  const spans: LemmaIngestSpan[] = (input.trace.spans ?? []).map(span => {
    const spanStart = timestamp(span.started_at, traceStart);
    const spanEnd = span.ended_at ? timestamp(span.ended_at, spanStart) : null;
    const spanId = normalizeSpanId(span.id, usedSpanIds);
    const parentId = span.parent_id ?? rootSpanId;
    const attributes = baseAttributes({
      input: span.input,
      output: span.output,
      metadata: span.metadata,
      attributes: {
        ...(span.attributes ?? {}),
        ...contractAttributes(span),
      },
      error: span.error,
    });

    if (span.type === 'generation') {
      attributes['openinference.span.kind'] = 'llm';
      if (span.model) {
        attributes['gen_ai.request.model'] = span.model;
        attributes['ai.model.id'] = span.model;
      }
      if (span.usage?.input_tokens != null) {
        attributes['gen_ai.usage.input_tokens'] = span.usage.input_tokens;
        attributes['ai.usage.inputTokens'] = span.usage.input_tokens;
      }
      if (span.usage?.output_tokens != null) {
        attributes['gen_ai.usage.output_tokens'] = span.usage.output_tokens;
        attributes['ai.usage.outputTokens'] = span.usage.output_tokens;
      }
    }

    if (span.type === 'tool') {
      const toolName = span.tool_name ?? span.name;
      attributes['openinference.span.kind'] = 'tool';
      attributes['tool.name'] = toolName;
      if ('input' in span) attributes['ai.toolCall.args'] = span.input;
      if ('output' in span) attributes['ai.toolCall.result'] = span.output;
    }

    return {
      trace_id_hex: traceId,
      otel_span_id: spanId,
      parent_otel_span_id: parentId,
      name: span.name,
      kind: span.type ?? 'span',
      start_time_ns: ns(spanStart),
      end_time_ns: spanEnd ? ns(spanEnd) : null,
      duration_ms: explicitDurationMs(span.duration_ms),
      status_code: statusCode(span.status, span.error),
      status_description: span.error ?? null,
      attributes,
      events: [],
      resource: {},
      input_tokens: span.usage?.input_tokens ?? null,
      output_tokens: span.usage?.output_tokens ?? null,
      model_name: span.model ?? null,
      tps: null,
    };
  });

  assignMissingChildDurations(rootSpan, spans);

  return {
    format: LEMMA_TRACE_PAYLOAD_FORMAT,
    version: LEMMA_TRACE_PAYLOAD_VERSION,
    project_id: input.project_id,
    produced_at: producedAt,
    traces: [
      {
        otel_trace_id: traceId,
        service_name: input.trace.environment ?? 'lemma-sdk',
      },
    ],
    spans: [rootSpan, ...spans],
  };
}

export async function handleSdkTraceIngest(
  request: Request,
  env: Env
): Promise<Response> {
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return buildJsonError(401, 'You must be authenticated');
  }

  try {
    const requestedAt = new Date().toISOString();
    const input = parseSdkTraceInput(await request.json());
    const payload = buildSdkTracePayload(input, requestedAt);
    await enqueueLemmaTracePayload({
      env,
      projectId: input.project_id,
      requestedAt,
      payload,
      authorization,
    });
    return new Response(null, { status: 201 });
  } catch (error) {
    if (error instanceof OtlpHttpTraceError) {
      return buildJsonError(error.status, error.message);
    }
    if (error instanceof SyntaxError) {
      return buildJsonError(400, 'Invalid JSON payload');
    }
    throw error;
  }
}
