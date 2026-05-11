import {
  type ProtoExportTraceServiceRequest,
  bytesToHex,
  kvsToDict,
  parseAgentIoAttributes,
  toNumber,
} from "./decode";
import {
  extractInputTokens,
  extractModelName,
  extractOutputTokens,
  extractTps,
} from "./span-extraction";
import {
  LEMMA_TRACE_PAYLOAD_FORMAT,
  LEMMA_TRACE_PAYLOAD_VERSION,
  type LemmaIngestSpan,
  type LemmaTracePayload,
} from "./lemma-trace-payload";

export function buildLemmaTracePayload(
  request: ProtoExportTraceServiceRequest,
  projectId: string,
  producedAt: string,
): LemmaTracePayload {
  const tracesMeta = new Map<string, { serviceName: string }>();
  const spans: LemmaIngestSpan[] = [];

  for (const resourceSpan of request.resourceSpans ?? []) {
    const resourceAttrs = kvsToDict(resourceSpan.resource?.attributes);
    for (const scopeSpans of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        const traceIdHex = bytesToHex(span.traceId);
        if (!traceIdHex) {
          continue;
        }
        const attrs = kvsToDict(span.attributes);
        parseAgentIoAttributes(attrs);
        const serviceName =
          typeof resourceAttrs["service.name"] === "string"
            ? String(resourceAttrs["service.name"])
            : "unknown";
        const startTimeNs = toNumber(span.startTimeUnixNano);

        if (!tracesMeta.has(traceIdHex)) {
          tracesMeta.set(traceIdHex, { serviceName });
        }

        const endTimeNs = toNumber(span.endTimeUnixNano);
        const durationMs =
          startTimeNs > 0 && endTimeNs > 0
            ? (endTimeNs - startTimeNs) / 1_000_000
            : null;
        const outputTokens = extractOutputTokens(attrs);

        spans.push({
          trace_id_hex: traceIdHex,
          otel_span_id: bytesToHex(span.spanId),
          parent_otel_span_id: bytesToHex(span.parentSpanId) || null,
          name: span.name || "",
          kind: span.kind != null ? String(span.kind) : null,
          start_time_ns: startTimeNs,
          end_time_ns: endTimeNs > 0 ? endTimeNs : null,
          duration_ms: durationMs,
          status_code: span.status?.code != null ? String(span.status.code) : null,
          status_description: span.status?.message ?? null,
          attributes: attrs,
          events: (span.events ?? []).map((event) => ({
            name: event.name ?? "event",
            timestamp_ns: toNumber(event.timeUnixNano),
            attributes: kvsToDict(event.attributes),
          })),
          resource: resourceAttrs,
          input_tokens: extractInputTokens(attrs),
          output_tokens: outputTokens,
          model_name: extractModelName(attrs),
          tps: extractTps(attrs, durationMs, outputTokens),
        });
      }
    }
  }

  return {
    format: LEMMA_TRACE_PAYLOAD_FORMAT,
    version: LEMMA_TRACE_PAYLOAD_VERSION,
    project_id: projectId,
    produced_at: producedAt,
    traces: Array.from(tracesMeta.entries()).map(([otelTraceId, meta]) => ({
      otel_trace_id: otelTraceId,
      service_name: meta.serviceName,
    })),
    spans,
  };
}
