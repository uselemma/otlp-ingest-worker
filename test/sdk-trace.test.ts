import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/config';
import worker from '../src/index';
import {
  LEMMA_TRACE_PAYLOAD_FORMAT,
  LEMMA_TRACE_PAYLOAD_VERSION,
} from '../src/otel/lemma-trace-payload';
import { OTLP_PAYLOAD_POINTER_VERSION } from '../src/shared/common/index';

const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const TRACE_ID = '10000000-0000-0000-0000-000000000001';

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

function makeEnv(): Env {
  return {
    LEMMA_API_URL: 'https://api.example',
    OTEL_PAYLOAD_KEY_PREFIX: 'otel:payload:v1',
    OTEL_PAYLOAD_TTL_SECONDS: '3600',
    OTEL_WORKER_AUTH_TOKEN: 'internal-only',
    WORKER_SHARED_SECRET: 'worker-shared-secret',
    S3_ENDPOINT: 'https://s3.example',
    S3_REGION: 'us-east-1',
    S3_OTEL_BUCKET: 'otel',
    OTEL_PUT_ACCESS_KEY_ID: 'garage-key',
    OTEL_PUT_SECRET_ACCESS_KEY: 'garage-secret',
    OTEL_BUCKET: {
      put: vi.fn(async () => undefined),
    } as unknown as R2Bucket,
    TRACE_BUFFER: {
      idFromName: vi.fn(),
      get: vi.fn(),
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

function asRequestBody(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function gunzipBody(body: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('gzip');
  const decompressed = await new Response(
    new Blob([asRequestBody(body)]).stream().pipeThrough(stream)
  ).arrayBuffer();
  return new Uint8Array(decompressed);
}

describe('POST /traces/ingest', () => {
  let apiFetch: ReturnType<typeof vi.fn>;
  let s3Fetch: ReturnType<typeof vi.fn>;

  function storedPayloadRequest(): Request {
    return s3Fetch.mock.calls[0][0] as Request;
  }

  function enqueuedPointer(): {
    project_id: string;
    requested_at: string;
    payload_key: string;
    payload_format: string;
    version: number;
  } {
    const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    return JSON.parse(init.body);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch = vi.fn(async () =>
      Response.json({ stream: 'otel-span-insert', entry_id: '1-0' })
    );
    s3Fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith('https://s3.example/')) return s3Fetch(input, init);
        return apiFetch(input, init);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores SDK JSON as a lemma trace payload and enqueues the pointer', async () => {
    const env = makeEnv();
    const request = new Request('https://worker.example/traces/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project_id: PROJECT_ID,
        trace: {
          id: TRACE_ID,
          name: 'support-agent',
          input: 'where is my order?',
          output: 'it arrives Friday',
          thread_id: 'thread-1',
          user_id: 'user-1',
          started_at: '2026-06-10T00:00:00.000Z',
          ended_at: '2026-06-10T00:00:01.000Z',
          duration_ms: 777,
          spans: [
            {
              id: 'model-turn',
              name: 'draft-reply',
              type: 'generation',
              input: [{ role: 'user', content: 'where is my order?' }],
              output: 'checking',
              model: 'gpt-4o',
              usage: { input_tokens: 12, output_tokens: 8 },
              duration_ms: 123,
              llm_input_messages: [
                { role: 'user', content: 'where is my order?' },
              ],
            },
            {
              id: 'tool-call',
              name: 'search_docs',
              type: 'tool',
              input: { query: 'order' },
              output: { status: 'shipped' },
              duration_ms: 45,
              tool_parameters: { query: 'string' },
            },
            {
              id: 'child-span',
              name: 'rerank',
              type: 'span',
              retrieval_documents: [{ id: 'doc-1', score: 0.91 }],
            },
          ],
        },
      }),
    });

    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(201);

    const [url, init] = apiFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.example/otlp/enqueue');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer key');

    const pointer = enqueuedPointer();
    expect(pointer.project_id).toBe(PROJECT_ID);
    expect(pointer.payload_key).toContain(`otel:payload:v1/${PROJECT_ID}/`);
    expect(pointer.payload_format).toBe(LEMMA_TRACE_PAYLOAD_FORMAT);
    expect(pointer.version).toBe(OTLP_PAYLOAD_POINTER_VERSION);

    const storedBody = new Uint8Array(
      await storedPayloadRequest().arrayBuffer()
    );
    const decodedBody = await gunzipBody(storedBody);
    const payload = JSON.parse(new TextDecoder().decode(decodedBody));

    expect(payload).toMatchObject({
      format: LEMMA_TRACE_PAYLOAD_FORMAT,
      version: LEMMA_TRACE_PAYLOAD_VERSION,
      project_id: PROJECT_ID,
      traces: [{ otel_trace_id: TRACE_ID, service_name: 'lemma-sdk' }],
    });
    expect(payload.spans).toMatchObject([
      {
        trace_id_hex: TRACE_ID,
        otel_span_id: `${TRACE_ID}:root`,
        parent_otel_span_id: null,
        name: 'support-agent',
        duration_ms: 777,
        attributes: {
          'gen_ai.agent.name': 'support-agent',
          'ai.agent.name': 'support-agent',
          'lemma.thread_id': 'thread-1',
          'user.id': 'user-1',
          'ai.agent.input': 'where is my order?',
          'ai.agent.output': 'it arrives Friday',
        },
      },
      {
        trace_id_hex: TRACE_ID,
        otel_span_id: 'model-turn',
        parent_otel_span_id: `${TRACE_ID}:root`,
        name: 'draft-reply',
        kind: 'generation',
        duration_ms: 123,
        input_tokens: 12,
        output_tokens: 8,
        model_name: 'gpt-4o',
        attributes: {
          'openinference.span.kind': 'llm',
          'gen_ai.request.model': 'gpt-4o',
          'llm.input_messages.0.message.content': 'where is my order?',
        },
      },
      {
        trace_id_hex: TRACE_ID,
        otel_span_id: 'tool-call',
        parent_otel_span_id: `${TRACE_ID}:root`,
        kind: 'tool',
        duration_ms: 45,
        attributes: {
          'openinference.span.kind': 'tool',
          'tool.name': 'search_docs',
          'tool.parameters': '{"query":"string"}',
          'ai.toolCall.args': { query: 'order' },
          'ai.toolCall.result': { status: 'shipped' },
        },
      },
      {
        trace_id_hex: TRACE_ID,
        otel_span_id: 'child-span',
        parent_otel_span_id: `${TRACE_ID}:root`,
        duration_ms: 609,
        attributes: {
          'retrieval.documents.0.document.id': 'doc-1',
          'retrieval.documents.0.document.score': 0.91,
        },
      },
    ]);
  });

  it('rejects SDK ingest without a bearer token before storing payloads', async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request('https://worker.example/traces/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: PROJECT_ID,
          trace: { name: 'support-agent' },
        }),
      }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(401);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(s3Fetch).not.toHaveBeenCalled();
  });
});
