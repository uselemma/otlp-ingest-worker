import root from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";
import worker from "../src/index";
import {
  LEMMA_TRACE_PAYLOAD_FORMAT,
  LEMMA_TRACE_PAYLOAD_VERSION,
} from "../src/otel/lemma-trace-payload";
import { OTLP_PAYLOAD_POINTER_VERSION } from "../src/shared/common/index";

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
    LEMMA_API_URL: "https://api.example",
    OTEL_PAYLOAD_KEY_PREFIX: "otel:payload:v1",
    OTEL_PAYLOAD_TTL_SECONDS: "3600",
    OTEL_WORKER_AUTH_TOKEN: "internal-only",
    WORKER_SHARED_SECRET: "worker-shared-secret",
    S3_ENDPOINT: "https://s3.example",
    S3_REGION: "us-east-1",
    S3_OTEL_BUCKET: "otel",
    OTEL_PUT_ACCESS_KEY_ID: "garage-key",
    OTEL_PUT_SECRET_ACCESS_KEY: "garage-secret",
    OTEL_BUCKET: {
      put: vi.fn(async () => undefined),
    } as unknown as R2Bucket,
    TRACE_BUFFER: {
      idFromName: vi.fn(),
      get: vi.fn(),
    } as unknown as DurableObjectNamespace,
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
  let apiFetch: ReturnType<typeof vi.fn>;
  let s3Fetch: ReturnType<typeof vi.fn>;

  /** The aws4fetch payload PUT arrives as a single signed Request. */
  function storedPayloadRequest(callIndex = 0): Request {
    return s3Fetch.mock.calls[callIndex][0] as Request;
  }

  async function storedPayloadBody(callIndex = 0): Promise<Uint8Array> {
    return new Uint8Array(
      await storedPayloadRequest(callIndex).clone().arrayBuffer(),
    );
  }

  function enqueuedPointer(callIndex = 0): {
    project_id: string;
    requested_at: string;
    payload_key: string;
    payload_format: string;
    version: number;
  } {
    const [, init] = apiFetch.mock.calls[callIndex] as [
      string,
      { body: string },
    ];
    return JSON.parse(init.body);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch = vi.fn(async () =>
      Response.json({ stream: "otel-span-insert", entry_id: "1-0" }),
    );
    s3Fetch = vi.fn(async () => new Response(null, { status: 200 }));
    // Dispatch by URL: payload PUTs go to the S3 stub, the rest to the API.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith("https://s3.example/")) return s3Fetch(input, init);
        return apiFetch(input, init);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects requests without a bearer token before calling the API", async () => {
    const env = makeEnv();
    const request = new Request("https://worker.example/otel/v1/traces", {
      method: "POST",
      headers: {
        "X-Lemma-Project-ID": PROJECT_ID,
        "Content-Type": "application/x-protobuf",
      },
      body: asRequestBody(protobufPayload()),
    });

    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(401);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("enqueues the pointer with the client's bearer token", async () => {
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
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://api.example/otlp/enqueue");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer key");
    const pointer = enqueuedPointer();
    expect(pointer.project_id).toBe(PROJECT_ID);
    expect(pointer.payload_key).toContain(`otel:payload:v1/${PROJECT_ID}/`);
    expect(pointer.payload_format).toBe(LEMMA_TRACE_PAYLOAD_FORMAT);
    expect(pointer.version).toBe(OTLP_PAYLOAD_POINTER_VERSION);
  });

  it("passes through authorization failures from the enqueue call", async () => {
    apiFetch.mockImplementation(async () =>
      Response.json({ detail: "Project not found" }, { status: 404 }),
    );
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
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      detail: "Project not found",
    });
    // The payload was stored before the rejected enqueue; the orphan expires
    // via the bucket lifecycle and its pointer never entered the stream.
    expect(s3Fetch).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the API is unreachable", async () => {
    apiFetch.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
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
    expect(response.status).toBe(503);
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
    expect(s3Fetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(storedPayloadRequest().method).toBe("PUT");
    expect(storedPayloadRequest().url).toContain(
      "https://s3.example/otel/otel%3Apayload%3Av1/",
    );
    const sent = enqueuedPointer();
    expect(sent.project_id).toBe(PROJECT_ID);
    expect(sent.payload_key).toContain(`otel:payload:v1/${PROJECT_ID}/`);
    expect(typeof sent.requested_at).toBe("string");
    expect(sent.payload_format).toBe(LEMMA_TRACE_PAYLOAD_FORMAT);
    expect(sent.version).toBe(OTLP_PAYLOAD_POINTER_VERSION);

    const storedBody = await storedPayloadBody();
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
    expect(storedPayloadRequest().headers.get("content-type")).toBe(
      "application/json",
    );
    const sent = enqueuedPointer();
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
    expect(apiFetch).not.toHaveBeenCalled();
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
