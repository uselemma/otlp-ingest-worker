import type { Env } from "../config";

export type OtlpHttpAuthResult =
  | { ok: true }
  | { ok: false; status: number; detail: string };

const INTERNAL_AUTH_HEADER = "X-Lemma-Internal-Authorization";

function extractInternalBearerToken(request: Request): string | null {
  const auth = request.headers.get(INTERNAL_AUTH_HEADER);
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Trusts only the API worker's internal handoff. Public bearer validation and
 * project ownership checks live in workers/api before this service binding call.
 */
export async function validateOtlpHttpAuth(
  request: Request,
  env: Env,
  _projectId: string,
): Promise<OtlpHttpAuthResult> {
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

  if (extractInternalBearerToken(request) === workerSharedSecret) {
    return { ok: true };
  }

  return { ok: false, status: 401, detail: "You must be authenticated" };
}
