import { resolveEnv, type Env } from "./config";
import { TraceBuffer } from "./fde_solutions";
import { handleOtlpV1Traces } from "./ingest/otlp-http-traces";

function buildJsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const resolvedEnv = await resolveEnv(env);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }
    if (request.method === "POST" && url.pathname === "/otel/v1/traces") {
      return handleOtlpV1Traces(request, resolvedEnv);
    }

    return buildJsonError(404, "Not found");
  },
};

export { TraceBuffer };
