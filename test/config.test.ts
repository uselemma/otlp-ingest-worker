import { beforeEach, describe, expect, it, vi } from "vitest";

describe("resolveEnv", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resolves WORKER_SHARED_SECRET from a Secrets Store binding", async () => {
    const { resolveEnv } = await import("../src/config");
    const workerSecretBinding = {
      get: vi.fn(async () => " shared-secret "),
    };

    const resolved = await resolveEnv({
      WORKER_SHARED_SECRET: workerSecretBinding,
      S3_ENDPOINT: "https://s3.example",
      S3_REGION: "us-east-1",
      OTEL_PUT_ACCESS_KEY_ID: "garage-key",
      OTEL_PUT_SECRET_ACCESS_KEY: "garage-secret",
      OTEL_BUCKET: {} as R2Bucket,
      TRACE_BUFFER: {
        idFromName: vi.fn(),
        get: vi.fn(),
      } as unknown as DurableObjectNamespace,
    } as unknown as Parameters<typeof resolveEnv>[0]);

    expect(workerSecretBinding.get).toHaveBeenCalledTimes(1);
    expect(resolved.WORKER_SHARED_SECRET).toBe("shared-secret");
  });
});

describe("resolveS3Config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const baseEnv = {
    WORKER_SHARED_SECRET: "shared-secret",
    S3_ENDPOINT: "https://s3.example",
    S3_REGION: "us-east-1",
    OTEL_BUCKET: {} as R2Bucket,
    TRACE_BUFFER: {} as DurableObjectNamespace,
  };

  it("builds the client config from the OTEL_PUT_* creds", async () => {
    const { resolveS3Config } = await import("../src/config");
    const config = await resolveS3Config({
      ...baseEnv,
      OTEL_PUT_ACCESS_KEY_ID: "put-key",
      OTEL_PUT_SECRET_ACCESS_KEY: "put-secret",
    } as unknown as Parameters<typeof resolveS3Config>[0]);

    expect(config.accessKeyId).toBe("put-key");
    expect(config.secretAccessKey).toBe("put-secret");
  });
});
