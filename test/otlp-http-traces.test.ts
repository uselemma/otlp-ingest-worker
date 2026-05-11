import root from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as otlpHttpAuth from "../src/auth/otlp-http-auth";
import type { Env, OtelSpanInsertQueueMessage } from "../src/config";
import worker from "../src/index";
import {
  LEMMA_TRACE_PAYLOAD_FORMAT,
  LEMMA_TRACE_PAYLOAD_VERSION,
} from "../src/otel/lemma-trace-payload";
import { OTLP_PAYLOAD_POINTER_VERSION } from "../src/shared/common/index";

vi.mock("../src/auth/otlp-http-auth", () => ({
  validateOtlpHttpAuth: vi.fn(),
}));

const mockedAuth = vi.mocked(otlpHttpAuth.validateOtlpHttpAuth);

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const TRACE_ID = "5b8efff798038103d269b633813fc60c";
const SPAN_ID = "051581bf3cb55c13";
const PARENT_SPAN_ID = "1111111111111111";

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

function makeEnv(): Env {
  return {
    INFISICAL_CLIENT_ID: "client-id",
    INFISICAL_CLIENT_SECRET: "client-secret",
    INFISICAL_PROJECT_ID: "project-id",
    INFISICAL_ENVIRONMENT: "dev",
    OTEL_PAYLOAD_KEY_PREFIX: "otel:payload:v1",
    OTEL_PAYLOAD_TTL_SECONDS: "3600",
    OTEL_WORKER_AUTH_TOKEN: "internal-only",
    WORKER_SHARED_SECRET: "worker-shared-secret",
    OTEL_SPAN_INSERT_QUEUE: {
      send: vi.fn(async () => undefined),
    } as unknown as Queue<OtelSpanInsertQueueMessage>,
    OTEL_SPAN_INSERT_DLQ: {
      send: vi.fn(async () => undefined),
    } as unknown as Queue<OtelSpanInsertQueueMessage>,
    OTEL_BUCKET: {
      put: vi.fn(async () => undefined),
    } as unknown as R2Bucket,
    CORE: {} as unknown as Fetcher,
  } as unknown as Env;
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

/** Detach a standalone `ArrayBuffer` for `Request` / `Blob` typing in Node. */
function asRequestBody(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function messageType() {
  const generatedRoot = (root as { default?: any }).default ?? root;
  return generatedRoot.opentelemetry.proto.collector.trace.v1
    .ExportTraceServiceRequest;
}

function protobufPayload(): Uint8Array {
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "router-test" },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: hexToBytes(TRACE_ID),
                spanId: hexToBytes(SPAN_ID),
                parentSpanId: hexToBytes(PARENT_SPAN_ID),
                name: "test-span",
                kind: 1,
                startTimeUnixNano: 1,
                endTimeUnixNano: 2,
              },
            ],
          },
        ],
      },
    ],
  };
  const type = messageType();
  return type.encode(type.fromObject(payload)).finish();
}

function jsonPayload(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "router-test" },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: TRACE_ID,
                  spanId: SPAN_ID,
                  parentSpanId: PARENT_SPAN_ID,
                  name: "test-span",
                  kind: 1,
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                },
              ],
            },
          ],
        },
      ],
    }),
  );
}

async function gunzipBody(body: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("gzip");
  const decompressed = await new Response(
    new Blob([asRequestBody(body)]).stream().pipeThrough(stream),
  ).arrayBuffer();
  return new Uint8Array(decompressed);
}

describe("POST /otel/v1/traces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({ ok: true });
  });

  it("returns 401 when auth fails", async () => {
    mockedAuth.mockResolvedValueOnce({
      ok: false,
      status: 401,
      detail: "You must be authenticated",
    });
    const env = makeEnv();
    const request = new Request("https://worker.example/otel/v1/traces", {
      method: "POST",
      headers: {
        Authorization: "Bearer x",
        "X-Lemma-Project-ID": PROJECT_ID,
        "Content-Type": "application/x-protobuf",
      },
      body: asRequestBody(protobufPayload()),
    });

    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(401);
  });

  it("accepts protobuf payload", async () => {
    const env = makeEnv();
    const request = new Request("https://worker.example/otel/v1/traces", {
      method: "POST",
      headers: {
        Authorization: "Bearer key",
        "X-Lemma-Project-ID": PROJECT_ID,
        "Content-Type": "application/x-protobuf",
      },
      body: asRequestBody(protobufPayload()),
    });

    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(env.OTEL_BUCKET.put).toHaveBeenCalledTimes(1);
    const queue = env.OTEL_SPAN_INSERT_QUEUE as unknown as {
      send: ReturnType<typeof vi.fn>;
    };
    expect(queue.send).toHaveBeenCalledTimes(1);
    const sent = queue.send.mock.calls[0][0] as {
      project_id: string;
      payload_key: string;
      requested_at: string;
      payload_format: string;
      version: number;
    };
    expect(sent.project_id).toBe(PROJECT_ID);
    expect(sent.payload_key).toContain(`otel:payload:v1/${PROJECT_ID}/`);
    expect(typeof sent.requested_at).toBe("string");
    expect(sent.payload_format).toBe(LEMMA_TRACE_PAYLOAD_FORMAT);
    expect(sent.version).toBe(OTLP_PAYLOAD_POINTER_VERSION);

    const putArgs = (env.OTEL_BUCKET.put as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const storedBody = putArgs[1] as Uint8Array;
    const decodedBody = await gunzipBody(storedBody);
    const payload = JSON.parse(new TextDecoder().decode(decodedBody)) as {
      format: string;
      version: number;
      project_id: string;
      traces: Array<{ otel_trace_id: string; service_name: string }>;
      spans: Array<{ trace_id_hex: string; otel_span_id: string }>;
    };
    expect(payload.format).toBe(LEMMA_TRACE_PAYLOAD_FORMAT);
    expect(payload.version).toBe(LEMMA_TRACE_PAYLOAD_VERSION);
    expect(payload.project_id).toBe(PROJECT_ID);
    expect(payload.traces).toEqual([
      { otel_trace_id: TRACE_ID, service_name: "router-test" },
    ]);
    expect(payload.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trace_id_hex: TRACE_ID,
          otel_span_id: SPAN_ID,
        }),
      ]),
    );
  });

  it("accepts JSON payload", async () => {
    const env = makeEnv();
    const request = new Request("https://worker.example/otel/v1/traces", {
      method: "POST",
      headers: {
        Authorization: "Bearer key",
        "X-Lemma-Project-ID": PROJECT_ID,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: asRequestBody(jsonPayload()),
    });

    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(200);
    const putArgs = (env.OTEL_BUCKET.put as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(putArgs[2].httpMetadata.contentType).toBe("application/json");
    const queue = env.OTEL_SPAN_INSERT_QUEUE as unknown as {
      send: ReturnType<typeof vi.fn>;
    };
    const sent = queue.send.mock.calls[0][0] as {
      payload_format: string;
      version: number;
    };
    expect(sent.payload_format).toBe(LEMMA_TRACE_PAYLOAD_FORMAT);
    expect(sent.version).toBe(OTLP_PAYLOAD_POINTER_VERSION);
  });

  it("accepts gzip content-encoding", async () => {
    const env = makeEnv();
    const raw = protobufPayload();
    const gz = await new Response(
      new Blob([asRequestBody(raw)]).stream().pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer();
    const request = new Request("https://worker.example/otel/v1/traces", {
      method: "POST",
      headers: {
        Authorization: "Bearer key",
        "X-Lemma-Project-ID": PROJECT_ID,
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "gzip",
      },
      body: gz,
    });

    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(200);
  });

  it("returns 400 for invalid OTLP JSON", async () => {
    const env = makeEnv();
    const bad = new TextEncoder().encode(
      JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "not-hex",
                    spanId: SPAN_ID,
                    parentSpanId: PARENT_SPAN_ID,
                    name: "x",
                    kind: 1,
                    startTimeUnixNano: "1",
                    endTimeUnixNano: "2",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const request = new Request("https://worker.example/otel/v1/traces", {
      method: "POST",
      headers: {
        Authorization: "Bearer key",
        "X-Lemma-Project-ID": PROJECT_ID,
        "Content-Type": "application/json",
      },
      body: asRequestBody(bad),
    });

    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(400);
    const queue = env.OTEL_SPAN_INSERT_QUEUE as unknown as {
      send: ReturnType<typeof vi.fn>;
    };
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("returns 415 for unsupported content encoding", async () => {
    const env = makeEnv();
    const request = new Request("https://worker.example/otel/v1/traces", {
      method: "POST",
      headers: {
        Authorization: "Bearer key",
        "X-Lemma-Project-ID": PROJECT_ID,
        "Content-Type": "application/json",
        "Content-Encoding": "br",
      },
      body: asRequestBody(jsonPayload()),
    });

    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(415);
  });
});
