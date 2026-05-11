export const LEMMA_TRACE_PAYLOAD_FORMAT = "lemma-trace-v1";
export const LEMMA_TRACE_PAYLOAD_VERSION = 1;

export interface LemmaSpanEvent {
  name: string;
  timestamp_ns: number;
  attributes: Record<string, unknown>;
}

export interface LemmaIngestSpan {
  trace_id_hex: string;
  otel_span_id: string;
  parent_otel_span_id: string | null;
  name: string;
  kind: string | null;
  start_time_ns: number;
  end_time_ns: number | null;
  duration_ms: number | null;
  status_code: string | null;
  status_description: string | null;
  attributes: Record<string, unknown>;
  events: LemmaSpanEvent[];
  resource: Record<string, unknown>;
  input_tokens: number | null;
  output_tokens: number | null;
  model_name: string | null;
  tps: number | null;
}

export interface LemmaIngestTrace {
  otel_trace_id: string;
  service_name: string;
}

export interface LemmaTracePayload {
  format: typeof LEMMA_TRACE_PAYLOAD_FORMAT;
  version: typeof LEMMA_TRACE_PAYLOAD_VERSION;
  project_id: string;
  produced_at: string;
  traces: LemmaIngestTrace[];
  spans: LemmaIngestSpan[];
}
