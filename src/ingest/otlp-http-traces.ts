import type { Env } from "../config";
import { fetchLemmaApi } from "../lemma-api";
import { resolveSolutionForProject } from "../fde_solutions";
import { decodeRequest, type ProtoExportTraceServiceRequest } from "../otel/decode";
import {
  OtlpHttpTraceError,
  runStandardIngest,
} from "../pipeline/run-standard-ingest";

const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
const JSON_CONTENT_TYPE = "application/json";
const SUPPORTED_CONTENT_TYPES = new Set([
  PROTOBUF_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
]);
const GZIP_CONTENT_ENCODING = "gzip";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidProjectId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

function buildJsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeMediaType(value: string | null | undefined): string {
  if (!value) return PROTOBUF_CONTENT_TYPE;
  return value.split(";", 1)[0].trim().toLowerCase();
}

function toStandaloneArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function gunzipBody(
  body: Uint8Array,
  contentEncoding: string | null,
): Promise<Uint8Array> {
  const encoding = (contentEncoding ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!encoding || encoding === "identity") {
    return body;
  }
  if (encoding !== GZIP_CONTENT_ENCODING) {
    throw new OtlpHttpTraceError(415, "Unsupported content encoding");
  }
  try {
    const stream = new DecompressionStream("gzip");
    const decompressed = await new Response(
      new Blob([toStandaloneArrayBuffer(body)]).stream().pipeThrough(stream),
    ).arrayBuffer();
    return new Uint8Array(decompressed);
  } catch {
    throw new OtlpHttpTraceError(400, "Invalid gzip payload");
  }
}

function resolveProjectId(request: Request, url: URL): string | null {
  const header = request.headers.get("X-Lemma-Project-ID");
  const query = url.searchParams.get("project_id");
  return header ?? query;
}

/**
 * Accept-time authorization for paths that respond 200 before any enqueue
 * happens (the buffered/FDE path flushes minutes later from a Durable Object
 * alarm with no client token in hand). Forwards the client's bearer token to
 * `GET /otlp/authorize`. The standard path skips this: its enqueue call
 * carries the auth itself, keeping the hot path at one API round trip.
 */
async function authorizeIngest(
  env: Env,
  projectId: string,
  authorization: string,
): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetchLemmaApi(
      env,
      `/otlp/authorize?project_id=${encodeURIComponent(projectId)}`,
      { headers: { authorization } },
    );
  } catch {
    return buildJsonError(503, "Authorization service is unavailable");
  }

  if (response.ok) {
    return null;
  }
  if (response.status >= 400 && response.status < 500) {
    const detail = await response
      .json()
      .then((body) => (body as { detail?: string }).detail)
      .catch(() => undefined);
    return buildJsonError(response.status, detail ?? "Not authorized");
  }
  return buildJsonError(503, "Authorization service is unavailable");
}

/**
 * Public OTLP HTTP ingest previously served by the Python API at `POST /otel/v1/traces`.
 */
export async function handleOtlpV1Traces(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const projectId = resolveProjectId(request, url);
  if (!isValidProjectId(projectId)) {
    return buildJsonError(
      400,
      "project_id must be provided as either Lemma-Project-ID header or project_id query parameter",
    );
  }

  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return buildJsonError(401, "You must be authenticated");
  }

  try {
    const requestedAt = new Date().toISOString();
    let parsedMemo: ProtoExportTraceServiceRequest | null = null;

    const decodeRequestMemoized =
      async (): Promise<ProtoExportTraceServiceRequest> => {
        if (parsedMemo) {
          return parsedMemo;
        }
        const raw = new Uint8Array(await request.arrayBuffer());
        const decoded = await gunzipBody(
          raw,
          request.headers.get("content-encoding"),
        );
        const contentType = normalizeMediaType(request.headers.get("content-type"));
        if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
          throw new OtlpHttpTraceError(415, "Unsupported OTLP content type");
        }
        try {
          parsedMemo = decodeRequest(decoded, contentType);
          return parsedMemo;
        } catch {
          throw new OtlpHttpTraceError(400, "Invalid OTLP payload");
        }
      };

    // FDE solutions take precedence over the standard pipeline. They run after
    // project_id validation but BEFORE we read/decode the body, so a
    // matched solution can choose to no-op, transform, or short-circuit.
    const fdeSolution = resolveSolutionForProject(projectId);
    if (fdeSolution) {
      // Buffered solutions ack the client before anything is enqueued, so
      // the client token must be validated at accept time.
      const unauthorized = await authorizeIngest(env, projectId, authorization);
      if (unauthorized) {
        return unauthorized;
      }
      console.log("fde_solution.matched", {
        solution: fdeSolution.name,
        project_id: projectId,
        requested_at: requestedAt,
      });
      // `await` so rejections resolve inside this try and map to HTTP errors.
      return await fdeSolution.handle({
        request,
        env,
        url,
        projectId,
        requestedAt,
        decodeRequest: decodeRequestMemoized,
        runStandardIngest: async (parsed) =>
          runStandardIngest({ env, projectId, requestedAt, parsed, authorization }),
      });
    }

    const parsed = await decodeRequestMemoized();
    return await runStandardIngest({
      env,
      projectId,
      requestedAt,
      parsed,
      authorization,
    });
  } catch (error) {
    if (error instanceof OtlpHttpTraceError) {
      return buildJsonError(error.status, error.message);
    }
    throw error;
  }
}
