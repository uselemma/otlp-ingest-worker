import { describe, expect, it, vi } from "vitest";

import type { Env, OtelSpanInsertQueueMessage } from "../../../src/config";
import { processorBufferedReparentSolution } from "../../../src/fde_solutions/solutions/processor-buffered-reparent";
import type { SolutionContext } from "../../../src/fde_solutions/types";
import type { ProtoExportTraceServiceRequest } from "../../../src/otel/decode";

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function makeParsedRequest(): ProtoExportTraceServiceRequest {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                spanId: hexToBytes("1111111111111111"),
                parentSpanId: new Uint8Array(),
                name: "ai.streamText",
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeContext(overrides?: {
  bucketPut?: ReturnType<typeof vi.fn>;
  appendFetch?: ReturnType<typeof vi.fn>;
  parsed?: ProtoExportTraceServiceRequest;
}): SolutionContext {
  const appendFetch = overrides?.appendFetch ?? vi.fn(async () => new Response(null, { status: 202 }));
  const env = {
    INFISICAL_CLIENT_ID: "client-id",
    INFISICAL_CLIENT_SECRET: "client-secret",
    INFISICAL_PROJECT_ID: "project-id",
    WORKER_SHARED_SECRET: "worker-secret",
    OTEL_SPAN_INSERT_QUEUE: {
      send: vi.fn(async () => undefined),
    } as unknown as Queue<OtelSpanInsertQueueMessage>,
    OTEL_SPAN_INSERT_DLQ: {
      send: vi.fn(async () => undefined),
    } as unknown as Queue<OtelSpanInsertQueueMessage>,
    OTEL_BUCKET: {
      put: overrides?.bucketPut ?? vi.fn(async () => undefined),
    } as unknown as R2Bucket,
    CORE: {} as Fetcher,
    TRACE_BUFFER: {
      idFromName: vi.fn(() => "trace-buffer-id" as unknown as DurableObjectId),
      get: vi.fn(() => ({ fetch: appendFetch }) as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace,
    PROCESSOR_BUFFERED_REPARENT_DEBUG_PAYLOADS: "true",
  } as unknown as Env;

  return {
    request: new Request("https://example.com/otel/v1/traces", { method: "POST" }),
    env,
    url: new URL("https://example.com/otel/v1/traces"),
    projectId: "00000000-0000-0000-0000-000000000001",
    requestedAt: "2026-01-01T00:00:00.000Z",
    decodeRequest: vi.fn(async () => overrides?.parsed ?? makeParsedRequest()),
    runStandardIngest: vi.fn(async () => new Response(null, { status: 200 })),
  };
}

describe("processorBufferedReparentSolution", () => {
  it("archives raw decoded OTLP payloads before buffering", async () => {
    const bucketPut = vi.fn(async () => undefined);
    const ctx = makeContext({ bucketPut });

    await processorBufferedReparentSolution.handle(ctx);

    expect(bucketPut).toHaveBeenCalledTimes(1);
    const [key, body, options] = bucketPut.mock.calls[0] as unknown as [
      string,
      Uint8Array,
      { customMetadata?: Record<string, string> },
    ];
    expect(key).toContain("debug/processor-buffered-reparent");
    expect(key).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(key).toContain("raw-ingest");
    expect(options.customMetadata?.stage).toBe("raw-ingest");
    const archived = JSON.parse(new TextDecoder().decode(body)) as {
      stage: string;
      payload: ProtoExportTraceServiceRequest;
    };
    expect(archived.stage).toBe("raw-ingest");
    expect(archived.payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name).toBe(
      "ai.streamText",
    );
  });
});
