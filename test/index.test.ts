import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";

import worker from "../src/index";

function makeEnv(): { env: Env } {
  const env = {
    OTEL_PAYLOAD_KEY_PREFIX: "otel:payload:v1",
    OTEL_PAYLOAD_TTL_SECONDS: "3600",
    OTEL_WORKER_AUTH_TOKEN: "secret",
    WORKER_SHARED_SECRET: "worker-shared-secret",
    S3_ENDPOINT: "https://s3.example",
    S3_REGION: "us-east-1",
    S3_OTEL_BUCKET: "otel",
    OTEL_PUT_ACCESS_KEY_ID: "garage-key",
    OTEL_PUT_SECRET_ACCESS_KEY: "garage-secret",
    OTEL_BUCKET: {} as unknown as R2Bucket,
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
    env.WORKER_SHARED_SECRET = "";

    await expect(
      worker.fetch(request, env, createExecutionContext().ctx),
    ).rejects.toThrow("Missing required environment variables: WORKER_SHARED_SECRET");
  });
});
