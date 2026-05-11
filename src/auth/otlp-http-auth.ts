import type { Env } from "../config";

export type OtlpHttpAuthResult =
  | { ok: true }
  | { ok: false; status: number; detail: string };

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Delegates validation to core (`/internal/otlp/validate-bearer`) so this worker stays DB-free.
 */
export async function validateOtlpHttpAuth(
  request: Request,
  env: Env,
): Promise<OtlpHttpAuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return { ok: false, status: 401, detail: "You must be authenticated" };
  }

  const workerSharedSecret =
    typeof env.WORKER_SHARED_SECRET === "string"
      ? env.WORKER_SHARED_SECRET.trim()
      : "";
  if (!workerSharedSecret) {
    return {
      ok: false,
      status: 503,
      detail: "WORKER_SHARED_SECRET is not configured",
    };
  }

  const response = await env.CORE.fetch(
    new Request("https://core.internal/internal/otlp/validate-bearer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerSharedSecret}`,
      },
      body: JSON.stringify({ token }),
    }),
  );

  if (response.status === 204) {
    return { ok: true };
  }

  let detail = "You must be authenticated";
  try {
    const text = await response.text();
    if (text.length > 0) {
      try {
        const body = JSON.parse(text) as { detail?: unknown };
        if (typeof body.detail === "string") detail = body.detail;
        else detail = text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // keep default detail
  }

  return {
    ok: false,
    status: response.status >= 400 ? response.status : 401,
    detail,
  };
}
