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
      INFISICAL_CLIENT_ID: "client-id",
      INFISICAL_CLIENT_SECRET: "client-secret",
      INFISICAL_PROJECT_ID: "project-id",
      WORKER_SHARED_SECRET: workerSecretBinding,
      OTEL_SPAN_INSERT_QUEUE: {} as Queue<{ project_id: string; requested_at: string; payload_key: string }>,
      OTEL_SPAN_INSERT_DLQ: {} as Queue<{ project_id: string; requested_at: string; payload_key: string }>,
      OTEL_BUCKET: {} as R2Bucket,
      CORE: {} as Fetcher,
      TRACE_BUFFER: {
        idFromName: vi.fn(),
        get: vi.fn(),
      } as unknown as DurableObjectNamespace,
    } as unknown as Parameters<typeof resolveEnv>[0]);

    expect(workerSecretBinding.get).toHaveBeenCalledTimes(1);
    expect(resolved.WORKER_SHARED_SECRET).toBe("shared-secret");
  });
});
