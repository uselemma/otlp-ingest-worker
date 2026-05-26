import type { ProtoExportTraceServiceRequest } from "../../../otel/decode";

type ProtoSpan = NonNullable<
  NonNullable<
    NonNullable<ProtoExportTraceServiceRequest["resourceSpans"]>[number]["scopeSpans"]
  >[number]["spans"]
>[number];

const AI_STREAM_TEXT = "ai.streamText";
const LANGFUSE_TRACE_OUTPUT_ATTR = "langfuse.trace.output";

export function isCompletingSpan(span: ProtoSpan): boolean {
  if (span.name !== AI_STREAM_TEXT) {
    return false;
  }
  return (
    span.attributes?.some(
      (attribute) =>
        attribute.key === LANGFUSE_TRACE_OUTPUT_ATTR &&
        typeof attribute.value?.stringValue === "string" &&
        attribute.value.stringValue.length > 0,
    ) ?? false
  );
}
