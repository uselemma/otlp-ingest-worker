import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env, OtelSpanInsertQueueMessage } from "../src/config";

import worker from "../src/index";

function makeEnv(): { env: Env } {
  const env = {
    INFISICAL_CLIENT_ID: "client-id",
    INFISICAL_CLIENT_SECRET: "client-secret",
    INFISICAL_PROJECT_ID: "project-id",
    INFISICAL_ENVIRONMENT: "dev",
    OTEL_PAYLOAD_KEY_PREFIX: "otel:payload:v1",
    OTEL_PAYLOAD_TTL_SECONDS: "3600",
    OTEL_WORKER_AUTH_TOKEN: "secret",
    WORKER_SHARED_SECRET: "worker-shared-secret",
    OTEL_SPAN_INSERT_QUEUE: {
      send: vi.fn(async () => undefined),
    } as unknown as Queue<OtelSpanInsertQueueMessage>,
    OTEL_SPAN_INSERT_DLQ: {
      send: vi.fn(async () => undefined),
    } as unknown as Queue<OtelSpanInsertQueueMessage>,
    OTEL_BUCKET: {} as unknown as R2Bucket,
    CORE: {} as unknown as Fetcher,
    TRACE_BUFFER: {
      idFromName: vi.fn(),
      get: vi.fn(),
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;

  return { env };
}

function createExecutionContext(): { ctx: ExecutionContext } {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx };
}

describe("otel ingest worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when required env is missing", async () => {
    const request = new Request("https://worker.example/health", {
      method: "GET",
    });
    const { env } = makeEnv();
    env.INFISICAL_CLIENT_ID = "";

    await expect(
      worker.fetch(request, env, createExecutionContext().ctx),
    ).rejects.toThrow("Missing required environment variables: INFISICAL_CLIENT_ID");
  });
});
