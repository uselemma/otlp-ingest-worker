import type { Env, OtelSpanInsertQueueMessage } from "../config";
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
 * Local-dev bypass: post the gzipped Lemma trace JSON straight to core via the
 * CORE service binding instead of going through R2 + queue.
 */
async function dispatchInlineToCore(
  env: Env,
  projectId: string,
  gzipped: Uint8Array,
  requestedAt: string,
): Promise<Response> {
  const workerSharedSecret =
    typeof env.WORKER_SHARED_SECRET === "string"
      ? env.WORKER_SHARED_SECRET.trim()
      : "";
  if (!workerSharedSecret) {
    throw new OtlpHttpTraceError(
      503,
      "WORKER_SHARED_SECRET is not configured for inline dispatch",
    );
  }

  // payload_key is informational in the inline path (no R2 round-trip), but we
  // still generate one so logs/workflow correlation in core match prod.
  const payloadKey = `inline:dev/${projectId}/${requestedAt}`;

  return env.CORE.fetch(
    new Request("https://core.internal/internal/otlp/ingest-inline", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${workerSharedSecret}`,
        "X-Lemma-Project-ID": projectId,
        "X-Lemma-Requested-At": requestedAt,
        "X-Lemma-Payload-Format": LEMMA_TRACE_PAYLOAD_FORMAT,
        "X-Lemma-Payload-Key": payloadKey,
        "X-Lemma-Pointer-Version": String(OTLP_PAYLOAD_POINTER_VERSION),
      },
      body: toStandaloneArrayBuffer(gzipped),
    }),
  );
}

export async function runStandardIngest(args: {
  env: Env;
  projectId: string;
  requestedAt: string;
  parsed: ProtoExportTraceServiceRequest;
}): Promise<Response> {
  const { env, projectId, requestedAt, parsed } = args;
  const payload = buildLemmaTracePayload(parsed, projectId, requestedAt);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const gzipped = await gzipBody(encoded);

  if (env.OTLP_DEV_INLINE_DISPATCH === "true") {
    const inlineResponse = await dispatchInlineToCore(
      env,
      projectId,
      gzipped,
      requestedAt,
    );
    if (inlineResponse.status >= 200 && inlineResponse.status < 300) {
      return new Response(null, { status: 200 });
    }
    const detail = await inlineResponse.text().catch(() => "");
    throw new OtlpHttpTraceError(
      502,
      `Inline dispatch to core failed (${inlineResponse.status}): ${detail || "no detail"}`,
    );
  }

  const payloadKey = await putPayload(
    env,
    projectId,
    gzipped,
    requestedAt,
    "application/json",
  );

  await env.OTEL_SPAN_INSERT_QUEUE.send({
    project_id: projectId,
    requested_at: requestedAt,
    payload_key: payloadKey,
    payload_format: LEMMA_TRACE_PAYLOAD_FORMAT,
    version: OTLP_PAYLOAD_POINTER_VERSION,
  } as OtelSpanInsertQueueMessage);

  return new Response(null, { status: 200 });
}
