import { describe, expect, it, vi } from "vitest";

import type { Env, OtelSpanInsertQueueMessage } from "../../../../src/config";
import { TraceBuffer } from "../../../../src/fde_solutions/processor-buffered-reparent/durable-objects/trace-buffer";
import type { TraceBufferAppendRequest } from "../../../../src/fde_solutions/processor-buffered-reparent/durable-objects/trace-buffer.types";

class MemoryStorage {
  private readonly map = new Map<string, unknown>();
  public alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(
    keyOrEntries: string | Record<string, unknown>,
    maybeValue?: unknown,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.map.set(keyOrEntries, maybeValue);
      return;
    }
    for (const [key, value] of Object.entries(keyOrEntries)) {
      this.map.set(key, value);
    }
  }

  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.map.entries()) {
      if (key.startsWith(prefix)) {
        out.set(key, value as T);
      }
    }
    return out;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
    this.alarmAt = null;
  }

  size(): number {
    return this.map.size;
  }
}

function makeState(storage: MemoryStorage): DurableObjectState {
  return {
    storage: storage as unknown as DurableObjectStorage,
  } as DurableObjectState;
}

function makeEnv(overrides?: {
  queueSend?: ReturnType<typeof vi.fn>;
  bucketPut?: ReturnType<typeof vi.fn>;
  bucketGet?: ReturnType<typeof vi.fn>;
}): Env {
  return {
    INFISICAL_CLIENT_ID: "client-id",
    INFISICAL_CLIENT_SECRET: "client-secret",
    INFISICAL_PROJECT_ID: "project-id",
    WORKER_SHARED_SECRET: "worker-secret",
    OTEL_PAYLOAD_KEY_PREFIX: "otel:payload:v1",
    OTEL_PAYLOAD_TTL_SECONDS: "3600",
    OTEL_SPAN_INSERT_QUEUE: {
      send: overrides?.queueSend ?? vi.fn(async () => undefined),
    } as unknown as Queue<OtelSpanInsertQueueMessage>,
    OTEL_SPAN_INSERT_DLQ: {
      send: vi.fn(async () => undefined),
    } as unknown as Queue<OtelSpanInsertQueueMessage>,
    OTEL_BUCKET: {
      put: overrides?.bucketPut ?? vi.fn(async () => undefined),
      get: overrides?.bucketGet ?? vi.fn(async () => null),
    } as unknown as R2Bucket,
    CORE: {} as Fetcher,
    TRACE_BUFFER: {
      idFromName: vi.fn(),
      get: vi.fn(),
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

function createRequest(payload: TraceBufferAppendRequest): Request {
  return new Request("https://trace-buffer.internal/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function gunzipBody(body: Uint8Array): Promise<Uint8Array> {
  const arrayBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(arrayBuffer).set(body);
  const stream = new DecompressionStream("gzip");
  const decompressed = await new Response(
    new Blob([arrayBuffer]).stream().pipeThrough(stream),
  ).arrayBuffer();
  return new Uint8Array(decompressed);
}

describe("TraceBuffer durable object", () => {
  it("deduplicates spans by span id", async () => {
    const storage = new MemoryStorage();
    const traceBuffer = new TraceBuffer(makeState(storage), makeEnv());

    const payload: TraceBufferAppendRequest = {
      projectId: "00000000-0000-0000-0000-000000000001",
      traceIdHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requestedAt: "2026-01-01T00:00:00.000Z",
      records: [
        {
          span: {
            traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            spanId: "1111111111111111",
            parentSpanId: "",
            name: "Processor.generation",
          },
        },
      ],
    };

    await traceBuffer.fetch(createRequest(payload));
    await traceBuffer.fetch(createRequest(payload));

    const meta = await storage.get<{ spanCount: number }>("meta:state");
    expect(meta?.spanCount).toBe(1);
  });

  it("debounces completion flush and emits synthetic tool spans", async () => {
    const storage = new MemoryStorage();
    const bucketPut = vi.fn(async () => undefined);
    const queueSend = vi.fn(async () => undefined);
    const env = makeEnv({ bucketPut, queueSend });
    const traceBuffer = new TraceBuffer(makeState(storage), env);

    const payload: TraceBufferAppendRequest = {
      projectId: "00000000-0000-0000-0000-000000000001",
      traceIdHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      requestedAt: "2026-01-01T00:00:00.000Z",
      records: [
        {
          span: {
            traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            spanId: "aaaaaaaaaaaaaaaa",
            parentSpanId: "ffffffffffffffff",
            name: "Processor.generation",
          },
        },
        {
          span: {
            traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            spanId: "bbbbbbbbbbbbbbbb",
            parentSpanId: "aaaaaaaaaaaaaaaa",
            name: "ai.streamText",
            startTimeUnixNano: "100",
            endTimeUnixNano: "200",
            attributes: [
              {
                key: "langfuse.trace.output",
                value: { stringValue: "done" },
              },
              {
                key: "ai.prompt",
                value: {
                  stringValue: JSON.stringify({
                    messages: [
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "tool-call",
                            toolCallId: "toolu_123",
                            toolName: "run_script",
                            args: { q: "a" },
                          },
                        ],
                      },
                      {
                        role: "tool",
                        content: [
                          {
                            type: "tool-result",
                            toolCallId: "toolu_123",
                            result: { ok: true },
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          },
        },
        {
          span: {
            traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            spanId: "cccccccccccccccc",
            parentSpanId: "bbbbbbbbbbbbbbbb",
            name: "ai.streamText.doStream",
            attributes: [
              {
                key: "ai.response.finishReason",
                value: { stringValue: "tool-calls" },
              },
              {
                key: "ai.response.toolCalls",
                value: {
                  stringValue: JSON.stringify([
                    {
                      toolCallId: "toolu_123",
                      toolName: "run_script",
                      args: { q: "a" },
                    },
                  ]),
                },
              },
            ],
          },
        },
        {
          span: {
            traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            spanId: "dddddddddddddddd",
            parentSpanId: "ffffffffffffffff",
            name: "Processor.tool",
            attributes: [
              {
                key: "gen_ai.tool.call.id",
                value: { stringValue: "toolu_123" },
              },
            ],
          },
        },
      ],
    };

    await traceBuffer.fetch(createRequest(payload));
    const firstAlarm = storage.alarmAt;
    expect(firstAlarm).toBeTruthy();

    // completion should not flush immediately; debounce is 30s
    await traceBuffer.alarm();
    expect(queueSend).toHaveBeenCalledTimes(0);

    // second append updates the same ai.streamText message payload before debounce expiry.
    await traceBuffer.fetch(
      createRequest({
        ...payload,
        records: payload.records.map((record) => {
          if (record.span.spanId === "bbbbbbbbbbbbbbbb") {
            return {
              ...record,
              span: {
                ...record.span,
                attributes: [
                  {
                    key: "langfuse.trace.output",
                    value: { stringValue: "done" },
                  },
                  {
                    key: "ai.prompt",
                    value: {
                      stringValue: JSON.stringify({
                        messages: [
                          {
                            role: "assistant",
                            content: [
                              {
                                type: "tool-call",
                                toolCallId: "toolu_123",
                                toolName: "run_script",
                                args: { q: "a" },
                              },
                              {
                                type: "tool-call",
                                toolCallId: "toolu_456",
                                toolName: "edit",
                                args: { file: "x.ts" },
                              },
                            ],
                          },
                          {
                            role: "tool",
                            content: [
                              {
                                type: "tool-result",
                                toolCallId: "toolu_123",
                                result: { ok: true },
                              },
                              {
                                type: "tool-result",
                                toolCallId: "toolu_456",
                                result: { ok: true },
                              },
                            ],
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
            };
          }
          if (record.span.spanId === "cccccccccccccccc") {
            return {
              ...record,
              span: {
                ...record.span,
                attributes: [
                  {
                    key: "ai.response.finishReason",
                    value: { stringValue: "tool-calls" },
                  },
                  {
                    key: "ai.response.toolCalls",
                    value: {
                      stringValue: JSON.stringify([
                        {
                          toolCallId: "toolu_123",
                          toolName: "run_script",
                          args: { q: "a" },
                        },
                        {
                          toolCallId: "toolu_456",
                          toolName: "edit",
                          args: { file: "x.ts" },
                        },
                      ]),
                    },
                  },
                ],
              },
            };
          }
          return record;
        }),
      }),
    );
    expect(storage.alarmAt).toBeTruthy();
    expect(storage.alarmAt!).toBeGreaterThanOrEqual(firstAlarm!);

    // Force debounce window elapsed.
    const meta = await storage.get<{
      lastAppendAt: number;
    }>("meta:state");
    await storage.put("meta:state", {
      ...(meta ?? {}),
      lastAppendAt: 0,
    });

    await traceBuffer.alarm();

    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(bucketPut).toHaveBeenCalledTimes(1);

    const bucketCalls = bucketPut.mock.calls as unknown as Array<
      [string, Uint8Array, unknown?]
    >;
    const firstCall = bucketCalls[0];
    expect(firstCall).toBeTruthy();
    const storedBody = firstCall?.[1];
    expect(storedBody).toBeInstanceOf(Uint8Array);
    const decodedBody = await gunzipBody(storedBody!);
    const parsed = JSON.parse(new TextDecoder().decode(decodedBody)) as {
      spans: Array<{ name: string; parent_otel_span_id: string | null }>;
    };
    expect(parsed.spans.some((span) => span.name === "Processor.tool")).toBe(false);
    expect(
      parsed.spans.some((span) => span.name?.startsWith("execute_tool ")),
    ).toBe(false);
    expect(
      parsed.spans.filter(
        (span) =>
          span.name === "ai.toolCall" &&
          span.parent_otel_span_id === "cccccccccccccccc",
      ).length,
    ).toBe(2);
    expect(storage.size()).toBe(0);
  });

  it("flushes on inactivity when no completion span arrives", async () => {
    const storage = new MemoryStorage();
    const queueSend = vi.fn(async () => undefined);
    const traceBuffer = new TraceBuffer(
      makeState(storage),
      makeEnv({ queueSend }),
    );

    await traceBuffer.fetch(
      createRequest({
        projectId: "00000000-0000-0000-0000-000000000001",
        traceIdHex: "cccccccccccccccccccccccccccccccc",
        requestedAt: "2026-01-01T00:00:00.000Z",
        records: [
          {
            span: {
              traceId: "cccccccccccccccccccccccccccccccc",
              spanId: "1111111111111111",
              parentSpanId: "",
              name: "Processor.generation",
            },
          },
        ],
      }),
    );

    const meta = await storage.get<{
      lastAppendAt: number;
      pendingFlushReason: string;
    }>("meta:state");
    expect(meta?.pendingFlushReason).toBe("inactivity");

    // Force the inactivity window to appear elapsed.
    await storage.put("meta:state", {
      ...(meta ?? {}),
      lastAppendAt: 0,
    });
    await traceBuffer.alarm();
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("spills oversized span entries to R2 before buffering", async () => {
    const storage = new MemoryStorage();
    const r2Objects = new Map<string, Uint8Array>();
    const bucketPut = vi.fn(async (key: string, body: Uint8Array) => {
      r2Objects.set(key, body);
    });
    const bucketGet = vi.fn(async (key: string) => {
      const body = r2Objects.get(key);
      if (!body) return null;
      return {
        text: async () => new TextDecoder().decode(body),
      };
    });
    const queueSend = vi.fn(async () => undefined);
    const traceBuffer = new TraceBuffer(
      makeState(storage),
      makeEnv({ bucketPut, bucketGet, queueSend }),
    );
    const largePrompt = "x".repeat(600_000);

    await traceBuffer.fetch(
      createRequest({
        projectId: "00000000-0000-0000-0000-000000000001",
        traceIdHex: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        requestedAt: "2026-01-01T00:00:00.000Z",
        records: [
          {
            span: {
              traceId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              spanId: "1111111111111111",
              parentSpanId: "",
              name: "ai.streamText",
              attributes: [
                {
                  key: "ai.prompt",
                  value: { stringValue: largePrompt },
                },
                {
                  key: "langfuse.trace.output",
                  value: { stringValue: "done" },
                },
              ],
            },
          },
        ],
      }),
    );

    const meta = await storage.get<{ lastAppendAt: number }>("meta:state");
    await storage.put("meta:state", {
      ...(meta ?? {}),
      lastAppendAt: 0,
    });
    await traceBuffer.alarm();

    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(bucketGet).toHaveBeenCalledWith(
      "trace-buffer-spans/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/1111111111111111.json",
    );
    expect(
      [...r2Objects.keys()].some((key) => key.startsWith("trace-buffer-spans/")),
    ).toBe(true);
  });

  it("retries dispatch and dead-letters after max attempts", async () => {
    const storage = new MemoryStorage();
    const bucketPut = vi.fn(async () => undefined);
    const queueSend = vi.fn(async () => {
      throw new Error("queue down");
    });
    const env = makeEnv({ bucketPut, queueSend });
    const traceBuffer = new TraceBuffer(makeState(storage), env);

    await traceBuffer.fetch(
      createRequest({
        projectId: "00000000-0000-0000-0000-000000000001",
        traceIdHex: "dddddddddddddddddddddddddddddddd",
        requestedAt: "2026-01-01T00:00:00.000Z",
        records: [
          {
            span: {
              traceId: "dddddddddddddddddddddddddddddddd",
              spanId: "1111111111111111",
              parentSpanId: "",
              name: "ai.streamText",
              attributes: [
                {
                  key: "langfuse.trace.output",
                  value: { stringValue: "done" },
                },
              ],
            },
          },
        ],
      }),
    );

    const meta = await storage.get<{ lastAppendAt: number }>("meta:state");
    await storage.put("meta:state", {
      ...(meta ?? {}),
      lastAppendAt: 0,
    });

    for (let i = 0; i < 5; i += 1) {
      await traceBuffer.alarm();
    }

    const bucketCalls = bucketPut.mock.calls as unknown as Array<
      [string, Uint8Array, unknown?]
    >;
    const deadLetterCall = bucketCalls.find((call) => {
      const key = call[0];
      return key.startsWith("dead-letter/");
    });
    expect(deadLetterCall).toBeTruthy();
    expect(storage.size()).toBe(0);
  });
});
