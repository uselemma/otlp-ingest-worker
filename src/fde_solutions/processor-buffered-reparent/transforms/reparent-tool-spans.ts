import { bytesToHex } from "../../../otel/decode";
import type { ProtoExportTraceServiceRequest } from "../../../otel/decode";

type ProtoResourceSpan = NonNullable<
  ProtoExportTraceServiceRequest["resourceSpans"]
>[number];
type ProtoScopeSpan = NonNullable<ProtoResourceSpan["scopeSpans"]>[number];
type ProtoSpan = NonNullable<ProtoScopeSpan["spans"]>[number];

const DO_STREAM = "ai.streamText.doStream";
const PROCESSOR_GENERATION = "Processor.generation";
const PROCESSOR_TOOL = "Processor.tool";
const TOOL_CALL_ID_ATTR = "gen_ai.tool.call.id";
const RESPONSE_TOOL_CALLS_ATTR = "ai.response.toolCalls";
const FINISH_REASON_ATTR = "ai.response.finishReason";
const FINISH_REASON_TOOL_CALLS = "tool-calls";

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function getAttribute(span: ProtoSpan, key: string): string | undefined {
  for (const attribute of span.attributes ?? []) {
    if (attribute.key !== key) continue;
    if (typeof attribute.value?.stringValue === "string") {
      return attribute.value.stringValue;
    }
  }
  return undefined;
}

function setStringAttribute(span: ProtoSpan, key: string, value: string): void {
  if (!span.attributes) {
    span.attributes = [];
  }
  const existing = span.attributes.find((attribute) => attribute.key === key);
  if (existing) {
    existing.value = { stringValue: value };
    return;
  }
  span.attributes.push({
    key,
    value: { stringValue: value },
  });
}

function parseToolCallIds(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const ids: string[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const maybeId =
        typeof (item as { toolCallId?: unknown }).toolCallId === "string"
          ? (item as { toolCallId: string }).toolCallId
          : typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : null;
      if (maybeId) {
        ids.push(maybeId);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function flattenSpans(request: ProtoExportTraceServiceRequest): ProtoSpan[] {
  const spans: ProtoSpan[] = [];
  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        spans.push(span);
      }
    }
  }
  return spans;
}

function findAncestorByName(
  span: ProtoSpan,
  spanById: Map<string, ProtoSpan>,
  ancestorName: string,
): ProtoSpan | null {
  let parentId = bytesToHex(span.parentSpanId);
  while (parentId) {
    const parent = spanById.get(parentId);
    if (!parent) {
      return null;
    }
    if (parent.name === ancestorName) {
      return parent;
    }
    parentId = bytesToHex(parent.parentSpanId);
  }
  return null;
}

export interface ReparentToolSpansStats {
  toolSpansSeen: number;
  reparented: number;
  unmatched: number;
}

export function reparentToolSpans(
  request: ProtoExportTraceServiceRequest,
): { request: ProtoExportTraceServiceRequest; stats: ReparentToolSpansStats } {
  const spans = flattenSpans(request);
  const spanById = new Map<string, ProtoSpan>();
  for (const span of spans) {
    const spanId = bytesToHex(span.spanId);
    if (spanId) {
      spanById.set(spanId, span);
    }
  }

  const generationByToolCallId = new Map<string, string>();
  for (const span of spans) {
    if (span.name !== DO_STREAM) {
      continue;
    }
    const finishReason = getAttribute(span, FINISH_REASON_ATTR);
    if (finishReason !== FINISH_REASON_TOOL_CALLS) {
      continue;
    }
    const toolCallIds = parseToolCallIds(
      getAttribute(span, RESPONSE_TOOL_CALLS_ATTR),
    );
    if (toolCallIds.length === 0) {
      continue;
    }
    const generation = findAncestorByName(
      span,
      spanById,
      PROCESSOR_GENERATION,
    );
    if (!generation) {
      continue;
    }
    const generationSpanId = bytesToHex(generation.spanId);
    if (!generationSpanId) {
      continue;
    }
    for (const toolCallId of toolCallIds) {
      generationByToolCallId.set(toolCallId, generationSpanId);
    }
  }

  const stats: ReparentToolSpansStats = {
    toolSpansSeen: 0,
    reparented: 0,
    unmatched: 0,
  };

  for (const span of spans) {
    if (span.name !== PROCESSOR_TOOL) {
      continue;
    }
    stats.toolSpansSeen += 1;
    const toolCallId = getAttribute(span, TOOL_CALL_ID_ATTR);
    if (!toolCallId) {
      stats.unmatched += 1;
      setStringAttribute(span, "lemma.reparent.unmatched", "true");
      continue;
    }
    const generationSpanId = generationByToolCallId.get(toolCallId);
    if (!generationSpanId) {
      stats.unmatched += 1;
      setStringAttribute(span, "lemma.reparent.unmatched", "true");
      setStringAttribute(span, "lemma.reparent.tool_call_id", toolCallId);
      continue;
    }
    const previousParent = bytesToHex(span.parentSpanId);
    span.parentSpanId = hexToBytes(generationSpanId);
    setStringAttribute(span, "lemma.original_parent_span_id", previousParent);
    setStringAttribute(span, "lemma.reparent.reason", "in_batch_match");
    stats.reparented += 1;
  }

  return { request, stats };
}
