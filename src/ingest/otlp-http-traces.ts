import type { Env, OtelSpanInsertQueueMessage } from "../config";
import { validateOtlpHttpAuth } from "../auth/otlp-http-auth";
import { decodeRequest } from "../otel/decode";
import { putPayload } from "../r2/payload-store";

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

class OtlpHttpTraceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OtlpHttpTraceError";
  }
}

async function gunzipBody(
  body: Uint8Array,
  contentEncoding: string | null,
): Promise<Uint8Array> {
  const encoding = (contentEncoding ?? "").split(";", 1)[0].trim().toLowerCase();
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

async function gzipBody(body: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const compressed = await new Response(
    new Blob([toStandaloneArrayBuffer(body)]).stream().pipeThrough(stream),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

function resolveProjectId(
  request: Request,
  url: URL,
): string | null {
  const header = request.headers.get("X-Lemma-Project-ID");
  const query = url.searchParams.get("project_id");
  return header ?? query;
}

/**
 * Public OTLP HTTP ingest previously served by the Python API at `POST /otel/v1/traces`.
 */
export async function handleOtlpV1Traces(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await validateOtlpHttpAuth(request, env);
  if (!auth.ok) {
    return buildJsonError(auth.status, auth.detail);
  }

  const url = new URL(request.url);
  const projectId = resolveProjectId(request, url);
  if (!isValidProjectId(projectId)) {
    return buildJsonError(
      400,
      "project_id must be provided as either Lemma-Project-ID header or project_id query parameter",
    );
  }

  try {
    const raw = new Uint8Array(await request.arrayBuffer());
    const decoded = await gunzipBody(raw, request.headers.get("content-encoding"));
    const contentType = normalizeMediaType(request.headers.get("content-type"));
    if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
      return buildJsonError(415, "Unsupported OTLP content type");
    }

    try {
      decodeRequest(decoded, contentType);
    } catch {
      return buildJsonError(400, "Invalid OTLP payload");
    }

    const requestedAt = new Date().toISOString();
    const gzipped = await gzipBody(decoded);
    const payloadKey = await putPayload(env, projectId, gzipped, requestedAt, contentType);

    await env.OTEL_SPAN_INSERT_QUEUE.send({
      project_id: projectId,
      requested_at: requestedAt,
      payload_key: payloadKey,
    } as OtelSpanInsertQueueMessage);

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof OtlpHttpTraceError) {
      return buildJsonError(error.status, error.message);
    }
    throw error;
  }
}
