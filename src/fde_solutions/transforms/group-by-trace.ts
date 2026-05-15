import { bytesToHex } from "../../otel/decode";
import type { ProtoExportTraceServiceRequest } from "../../otel/decode";

type ProtoResourceSpan = NonNullable<
  ProtoExportTraceServiceRequest["resourceSpans"]
>[number];
type ProtoScopeSpan = NonNullable<ProtoResourceSpan["scopeSpans"]>[number];
type ProtoSpan = NonNullable<ProtoScopeSpan["spans"]>[number];

export interface BufferedSpan
  extends Omit<ProtoSpan, "traceId" | "spanId" | "parentSpanId"> {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface BufferedSpanRecord {
  span: BufferedSpan;
  resource?: ProtoResourceSpan["resource"];
  scope?: ProtoScopeSpan["scope"];
}

export interface TraceGroup {
  traceIdHex: string;
  records: BufferedSpanRecord[];
}

function serializeSpan(span: ProtoSpan): BufferedSpan {
  const traceId = bytesToHex(span.traceId);
  const spanId = bytesToHex(span.spanId);
  const parentSpanId = bytesToHex(span.parentSpanId);
  const { traceId: _traceId, spanId: _spanId, parentSpanId: _parentSpanId, ...rest } =
    span;
  return {
    ...rest,
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
  };
}

export function groupByTraceId(
  request: ProtoExportTraceServiceRequest,
): TraceGroup[] {
  const byTraceId = new Map<string, TraceGroup>();

  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        const traceIdHex = bytesToHex(span.traceId);
        if (!traceIdHex) {
          continue;
        }
        const existing = byTraceId.get(traceIdHex);
        const record: BufferedSpanRecord = {
          span: serializeSpan(span),
          resource: resourceSpan.resource,
          scope: scopeSpans.scope,
        };
        if (existing) {
          existing.records.push(record);
        } else {
          byTraceId.set(traceIdHex, {
            traceIdHex,
            records: [record],
          });
        }
      }
    }
  }

  return [...byTraceId.values()];
}
