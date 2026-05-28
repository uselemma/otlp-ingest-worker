import { describe, expect, it } from "vitest";

import { validateOtlpHttpAuth } from "../src/auth/otlp-http-auth";
import type { Env } from "../src/config";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    WORKER_SHARED_SECRET: "worker-shared-secret",
    ...overrides,
  } as Env;
}

describe("validateOtlpHttpAuth", () => {
  it("accepts the API worker internal handoff secret", async () => {
    const request = new Request("https://otlp.internal/otel/v1/traces", {
      headers: {
        "X-Lemma-Internal-Authorization": "Bearer worker-shared-secret",
      },
    });

    await expect(
      validateOtlpHttpAuth(request, makeEnv(), "project-1"),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects public bearer tokens without the internal handoff secret", async () => {
    const request = new Request("https://otlp.internal/otel/v1/traces", {
      headers: {
        Authorization: "Bearer sk_public",
      },
    });

    await expect(
      validateOtlpHttpAuth(request, makeEnv(), "project-1"),
    ).resolves.toEqual({
      ok: false,
      status: 401,
      detail: "You must be authenticated",
    });
  });
});
