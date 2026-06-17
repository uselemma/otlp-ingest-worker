import type { Env, OtelSpanInsertPointer } from "../config";
import { fetchLemmaApi } from "../lemma-api";
import { buildLemmaTracePayload } from "../otel/build-payload";
import type { ProtoExportTraceServiceRequest } from "../otel/decode";
import { LEMMA_TRACE_PAYLOAD_FORMAT } from "../otel/lemma-trace-payload";
import { putPayload } from "../r2/payload-store";
import { OTLP_PAYLOAD_POINTER_VERSION } from "../shared/common/index";

function toStandaloneArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function gzipBody(body: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const compressed = await new Response(
    new Blob([toStandaloneArrayBuffer(body)]).stream().pipeThrough(stream),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

export class OtlpHttpTraceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OtlpHttpTraceError";
  }
}

/**
 * Append the payload pointer to the ingest stream via the Lemma API. The
 * bearer token carries the authorization: the client's own token on the hot
 * path (the API validates project ownership), or WORKER_SHARED_SECRET for
 * deferred flushes that no longer hold a client token. A 2xx means durably
 * queued; anything else surfaces as a retryable error and the stored payload
 * expires via the bucket lifecycle.
 */
async function enqueuePointer(
  env: Env,
  pointer: OtelSpanInsertPointer,
  authorization: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchLemmaApi(env, "/otlp/enqueue", {
      method: "POST",
      headers: {
        authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pointer),
    });
  } catch {
    throw new OtlpHttpTraceError(503, "Ingest enqueue is unavailable");
  }

  if (response.ok) {
    return;
  }
  if (response.status >= 400 && response.status < 500) {
    const detail = await response
      .json()
      .then((body) => (body as { detail?: string }).detail)
      .catch(() => undefined);
    throw new OtlpHttpTraceError(response.status, detail ?? "Not authorized");
  }
  throw new OtlpHttpTraceError(503, "Ingest enqueue is unavailable");
}

export async function runStandardIngest(args: {
  env: Env;
  projectId: string;
  requestedAt: string;
  parsed: ProtoExportTraceServiceRequest;
  /** Bearer header for the enqueue call (client token or worker secret). */
  authorization: string;
}): Promise<Response> {
  const { env, projectId, requestedAt, parsed, authorization } = args;
  const payload = buildLemmaTracePayload(parsed, projectId, requestedAt);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const gzipped = await gzipBody(encoded);

  const payloadKey = await putPayload(
    env,
    projectId,
    gzipped,
    requestedAt,
    "application/json",
  );

  await enqueuePointer(
    env,
    {
      project_id: projectId,
      requested_at: requestedAt,
      payload_key: payloadKey,
      payload_format: LEMMA_TRACE_PAYLOAD_FORMAT,
      version: OTLP_PAYLOAD_POINTER_VERSION,
    },
    authorization,
  );

  return new Response(null, { status: 200 });
}
