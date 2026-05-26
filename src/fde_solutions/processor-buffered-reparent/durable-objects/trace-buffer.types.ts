import type { ProtoExportTraceServiceRequest } from "../../../otel/decode";
import type { BufferedSpanRecord } from "../transforms/group-by-trace";

type ProtoResourceSpan = NonNullable<
  ProtoExportTraceServiceRequest["resourceSpans"]
>[number];
type ProtoScopeSpan = NonNullable<ProtoResourceSpan["scopeSpans"]>[number];

export interface TraceBufferAppendRequest {
  projectId: string;
  traceIdHex: string;
  requestedAt: string;
  records: BufferedSpanRecord[];
}

export interface TraceBufferMetaState {
  projectId: string;
  traceIdHex: string;
  firstAppendAt: number;
  lastAppendAt: number;
  spanCount: number;
  isComplete: boolean;
  flushAttempts: number;
  pendingFlushReason: "completion" | "inactivity" | "span_cap" | "hard_cap";
}

export interface StoredSpanEntry {
  span?: BufferedSpanRecord["span"];
  spanR2Key?: string;
  resourceFp: string;
  scopeFp: string;
}

export interface StoredSpanR2Entry extends StoredSpanEntry {
  span: BufferedSpanRecord["span"];
  resource?: ProtoResourceSpan["resource"];
  scope?: ProtoScopeSpan["scope"];
}

export type StoredResource = ProtoResourceSpan["resource"];
export type StoredScope = ProtoScopeSpan["scope"];
