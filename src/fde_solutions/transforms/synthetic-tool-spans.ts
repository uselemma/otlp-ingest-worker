import { bytesToHex, toNumber } from "../../otel/decode";
import type { ProtoExportTraceServiceRequest } from "../../otel/decode";

type ProtoResourceSpan = NonNullable<
  ProtoExportTraceServiceRequest["resourceSpans"]
>[number];
type ProtoScopeSpan = NonNullable<ProtoResourceSpan["scopeSpans"]>[number];
type ProtoSpan = NonNullable<ProtoScopeSpan["spans"]>[number];

type PromptToolCall = {
  id: string;
  name?: string;
  args?: unknown;
  result?: unknown;
};

type ProtoKeyValue = NonNullable<ProtoSpan["attributes"]>[number];

const AI_STREAM_TEXT = "ai.streamText";
const AI_STREAM_TEXT_PARENT = "ai.agent";
const AI_AGENT_OPERATION_ID = "ai.agent.run";
const AI_STREAM_TEXT_DO_STREAM = "ai.streamText.doStream";
const AI_GENERATE_OBJECT_PREFIX = "ai.generateObject";
const AI_SPAN_PREFIX = "ai.";
const AI_TOOLCALL_SPAN_NAME = "ai.toolCall";
const PROCESSOR_TOOL = "Processor.tool";
const EXECUTE_TOOL_PREFIX = "execute_tool ";
const RESPONSE_TOOL_CALLS_ATTR = "ai.response.toolCalls";
const INPUT_ATTR_KEYS = new Set(["ai.prompt", "langfuse.trace.input"]);
const AGENT_NAME_ATTR_KEYS = [
  "ai.agent.name",
  "gen_ai.agent.name",
  "lemma.agent_name",
  "agent.name",
];
const RESERVED_AGENT_ATTR_KEYS = new Set([
  "operation.name",
  "ai.operationId",
  "lemma.synthetic",
  "lemma.synthetic.kind",
  "span.type",
  "openinference.span.kind",
  "ai.agent.input",
  "ai.agent.output",
  "lemma.thread_id",
]);

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

function getStringAttribute(span: ProtoSpan, key: string): string | undefined {
  for (const attribute of span.attributes ?? []) {
    if (attribute.key === key && typeof attribute.value?.stringValue === "string") {
      return attribute.value.stringValue;
    }
  }
  return undefined;
}

function stableHashHex(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned.toString(16).padStart(8, "0");
}

function uniqueSyntheticSpanId(
  traceIdHex: string,
  parentSpanIdHex: string,
  toolCallId: string,
  existing: Set<string>,
  index: number,
): string {
  let candidate = `${stableHashHex(`${traceIdHex}:${parentSpanIdHex}:${toolCallId}:${index}`)}${stableHashHex(`lemma:${index}:${toolCallId}`)}`;
  if (!existing.has(candidate)) {
    return candidate;
  }
  let salt = 1;
  while (existing.has(candidate)) {
    candidate = `${stableHashHex(`${traceIdHex}:${parentSpanIdHex}:${toolCallId}:${index}:${salt}`)}${stableHashHex(`lemma:${salt}:${toolCallId}`)}`;
    salt += 1;
  }
  return candidate;
}

function asJsonString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parsePromptToolCalls(promptRaw: string | undefined): PromptToolCall[] {
  if (!promptRaw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(promptRaw);
  } catch {
    return [];
  }
  const messages = Array.isArray((parsed as { messages?: unknown }).messages)
    ? ((parsed as { messages: unknown[] }).messages ?? [])
    : Array.isArray(parsed)
      ? parsed
      : [];

  const byId = new Map<string, PromptToolCall>();
  const order: string[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = (part as { type?: unknown }).type;
      const rawId =
        (part as { toolCallId?: unknown }).toolCallId ??
        (part as { id?: unknown }).id;
      const toolCallId = typeof rawId === "string" ? rawId : null;
      if (!toolCallId) continue;

      if (type === "tool-call") {
        const existing = byId.get(toolCallId) ?? { id: toolCallId };
        existing.name =
          typeof (part as { toolName?: unknown }).toolName === "string"
            ? ((part as { toolName: string }).toolName ?? existing.name)
            : typeof (part as { name?: unknown }).name === "string"
              ? ((part as { name: string }).name ?? existing.name)
              : existing.name;
        existing.args =
          (part as { args?: unknown }).args ??
          (part as { input?: unknown }).input ??
          existing.args;
        byId.set(toolCallId, existing);
        if (!order.includes(toolCallId)) order.push(toolCallId);
      } else if (type === "tool-result") {
        const existing = byId.get(toolCallId) ?? { id: toolCallId };
        existing.result =
          (part as { result?: unknown }).result ??
          (part as { output?: unknown }).output ??
          existing.result;
        byId.set(toolCallId, existing);
        if (!order.includes(toolCallId)) order.push(toolCallId);
      }
    }
  }

  return order
    .map((id) => byId.get(id))
    .filter((item): item is PromptToolCall => Boolean(item));
}

function parseResponseToolCalls(value: string | undefined): PromptToolCall[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PromptToolCall[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const id =
        typeof (item as { toolCallId?: unknown }).toolCallId === "string"
          ? (item as { toolCallId: string }).toolCallId
          : typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : null;
      if (!id) continue;
      const name =
        typeof (item as { toolName?: unknown }).toolName === "string"
          ? (item as { toolName: string }).toolName
          : typeof (item as { name?: unknown }).name === "string"
            ? (item as { name: string }).name
            : undefined;
      const args =
        (item as { args?: unknown }).args ??
        (item as { input?: unknown }).input ??
        undefined;
      out.push({ id, name, args });
    }
    return out;
  } catch {
    return [];
  }
}

function setSyntheticAttributes(span: ProtoSpan, toolCall: PromptToolCall): void {
  span.attributes = [
    {
      key: "operation.name",
      value: { stringValue: AI_TOOLCALL_SPAN_NAME },
    },
    {
      key: "ai.operationId",
      value: { stringValue: AI_TOOLCALL_SPAN_NAME },
    },
    {
      key: "lemma.synthetic",
      value: { boolValue: true },
    },
    {
      key: "lemma.synthetic.kind",
      value: { stringValue: "tool_call" },
    },
    {
      key: "ai.toolCall.id",
      value: { stringValue: toolCall.id },
    },
    {
      key: "ai.toolCall.name",
      value: { stringValue: toolCall.name ?? "unknown" },
    },
  ];

  if (toolCall.args !== undefined) {
    span.attributes.push({
      key: "ai.toolCall.args",
      value: { stringValue: asJsonString(toolCall.args) },
    });
  }
  if (toolCall.result !== undefined) {
    span.attributes.push({
      key: "ai.toolCall.result",
      value: { stringValue: asJsonString(toolCall.result) },
    });
  }
}

function isOutputAttributeKey(key: string): boolean {
  return (
    key === "langfuse.trace.output" ||
    key === "ai.response.text" ||
    key === "gen_ai.output.type" ||
    key.startsWith("ai.response.") ||
    key.startsWith("ai.usage.")
  );
}

function attributeValueToStableString(attribute: ProtoKeyValue): string {
  const value = attribute.value ?? {};
  if (value.stringValue !== undefined) return `s:${value.stringValue}`;
  if (value.boolValue !== undefined) return `b:${String(value.boolValue)}`;
  if (value.intValue !== undefined) return `i:${String(value.intValue)}`;
  if (value.doubleValue !== undefined) return `d:${String(value.doubleValue)}`;
  if (value.arrayValue !== undefined) return `a:${JSON.stringify(value.arrayValue)}`;
  if (value.kvlistValue !== undefined) return `k:${JSON.stringify(value.kvlistValue)}`;
  if (value.bytesValue !== undefined) return `y:${bytesToHex(value.bytesValue)}`;
  return "n:";
}

function collectInvariantMetadataAttributes(spans: ProtoSpan[]): ProtoKeyValue[] {
  const first = spans[0];
  if (!first) return [];
  const out: ProtoKeyValue[] = [];
  const firstAttrs = first.attributes ?? [];

  for (const attr of firstAttrs) {
    const key = attr.key;
    if (RESERVED_AGENT_ATTR_KEYS.has(key)) continue;
    if (AGENT_NAME_ATTR_KEYS.includes(key)) continue;
    if (INPUT_ATTR_KEYS.has(key)) continue;
    if (isOutputAttributeKey(key)) continue;
    const expected = attributeValueToStableString(attr);

    const presentInAll = spans.every((span) => {
      const candidate = (span.attributes ?? []).find((item) => item.key === key);
      if (!candidate) return false;
      return attributeValueToStableString(candidate) === expected;
    });
    if (presentInAll) {
      out.push(structuredClone(attr));
    }
  }

  return out;
}

function mergeAttributesByKey(...groups: ProtoKeyValue[][]): ProtoKeyValue[] {
  const merged = new Map<string, ProtoKeyValue>();
  for (const group of groups) {
    for (const attr of group) {
      merged.set(attr.key, structuredClone(attr));
    }
  }
  return [...merged.values()];
}

function collectAgentCarryAttributes(first: ProtoSpan, last: ProtoSpan): ProtoKeyValue[] {
  const carried = new Map<string, ProtoKeyValue>();

  for (const attribute of first.attributes ?? []) {
    if (INPUT_ATTR_KEYS.has(attribute.key)) {
      carried.set(attribute.key, structuredClone(attribute));
    }
  }

  for (const attribute of last.attributes ?? []) {
    if (isOutputAttributeKey(attribute.key)) {
      carried.set(attribute.key, structuredClone(attribute));
    }
  }

  return [...carried.values()];
}

function getAttribute(span: ProtoSpan, key: string): ProtoKeyValue | undefined {
  return (span.attributes ?? []).find((attribute) => attribute.key === key);
}

function getAgentNameForGrouping(span: ProtoSpan): string {
  for (const key of AGENT_NAME_ATTR_KEYS) {
    const attribute = getAttribute(span, key);
    const value = attribute?.value?.stringValue;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function getSessionIdForGrouping(span: ProtoSpan): string {
  const threadId = getAttribute(span, "lemma.thread_id")?.value?.stringValue;
  if (typeof threadId === "string" && threadId.trim().length > 0) {
    return threadId.trim();
  }
  const sessionId = getAttribute(span, "session.id")?.value?.stringValue;
  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    return sessionId.trim();
  }
  return "";
}

function makeAgentGroupKey(
  traceIdHex: string,
  parentSpanIdHex: string,
  agentName: string,
  sessionId: string,
): string {
  return `${traceIdHex}|${parentSpanIdHex}|${agentName}|${sessionId}`;
}

function makeToolResultScopeKey(
  traceIdHex: string,
  agentName: string,
  sessionId: string,
): string {
  return `${traceIdHex}|${agentName}|${sessionId}`;
}

function derivedTraceIdHex(groupKey: string): string {
  return [
    stableHashHex(`trace:${groupKey}:0`),
    stableHashHex(`trace:${groupKey}:1`),
    stableHashHex(`trace:${groupKey}:2`),
    stableHashHex(`trace:${groupKey}:3`),
  ].join("");
}

function spanStartNs(span: ProtoSpan): number {
  const start = toNumber(span.startTimeUnixNano);
  return start > 0 ? start : 0;
}

function spanEndNs(span: ProtoSpan): number {
  const end = toNumber(span.endTimeUnixNano);
  if (end > 0) return end;
  const start = spanStartNs(span);
  return start > 0 ? start : 0;
}

function toAgentInputOutputAttributes(
  first: ProtoSpan,
  last: ProtoSpan,
): ProtoKeyValue[] {
  const attrs: ProtoKeyValue[] = [];
  const inputSource =
    getAttribute(first, "langfuse.trace.input") ?? getAttribute(first, "ai.prompt");
  const outputSource =
    getAttribute(last, "langfuse.trace.output") ??
    getAttribute(last, "ai.response.text") ??
    getAttribute(last, "gen_ai.completion");

  if (inputSource?.value) {
    attrs.push({
      key: "ai.agent.input",
      value: structuredClone(inputSource.value),
    });
  }
  if (outputSource?.value) {
    attrs.push({
      key: "ai.agent.output",
      value: structuredClone(outputSource.value),
    });
  }
  return attrs;
}

function toAgentThreadIdAttribute(spans: ProtoSpan[]): ProtoKeyValue[] {
  for (const span of spans) {
    const existingThreadId = getAttribute(span, "lemma.thread_id");
    if (existingThreadId?.value) {
      return [
        {
          key: "lemma.thread_id",
          value: structuredClone(existingThreadId.value),
        },
      ];
    }
    const sessionId = getAttribute(span, "session.id");
    if (sessionId?.value) {
      return [
        {
          key: "lemma.thread_id",
          value: structuredClone(sessionId.value),
        },
      ];
    }
  }
  return [];
}

function toCanonicalAgentNameAttribute(agentName: string): ProtoKeyValue[] {
  if (!agentName) return [];
  return [
    {
      key: "gen_ai.agent.name",
      value: { stringValue: agentName },
    },
  ];
}

function getStreamTextGroupKey(span: ProtoSpan): string | undefined {
  const traceIdHex = bytesToHex(span.traceId);
  if (!traceIdHex) return undefined;
  return makeAgentGroupKey(
    traceIdHex,
    bytesToHex(span.parentSpanId),
    getAgentNameForGrouping(span),
    getSessionIdForGrouping(span),
  );
}

function getToolResultScopeKey(span: ProtoSpan): string | undefined {
  const traceIdHex = bytesToHex(span.traceId);
  if (!traceIdHex) return undefined;
  return makeToolResultScopeKey(
    traceIdHex,
    getAgentNameForGrouping(span),
    getSessionIdForGrouping(span),
  );
}

function buildToolResultsByStreamTextScope(request: ProtoExportTraceServiceRequest): {
  byGroup: Map<string, Map<string, PromptToolCall>>;
  byResultScope: Map<string, Map<string, PromptToolCall>>;
} {
  const byGroup = new Map<string, Map<string, PromptToolCall>>();
  const byResultScope = new Map<string, Map<string, PromptToolCall>>();

  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        if (span.name !== AI_STREAM_TEXT) continue;
        const groupKey = getStreamTextGroupKey(span);
        const resultScopeKey = getToolResultScopeKey(span);
        if (!groupKey) continue;
        const promptCalls = parsePromptToolCalls(getStringAttribute(span, "ai.prompt"));
        for (const call of promptCalls) {
          if (call.result === undefined) continue;
          const groupResults = byGroup.get(groupKey) ?? new Map<string, PromptToolCall>();
          groupResults.set(call.id, call);
          byGroup.set(groupKey, groupResults);
          if (resultScopeKey) {
            const scopedResults =
              byResultScope.get(resultScopeKey) ?? new Map<string, PromptToolCall>();
            scopedResults.set(call.id, call);
            byResultScope.set(resultScopeKey, scopedResults);
          }
        }
      }
    }
  }

  return { byGroup, byResultScope };
}

function uniqueSyntheticStreamParentSpanId(
  traceIdHex: string,
  groupKey: string,
  existing: Set<string>,
): string {
  let candidate = `${stableHashHex(`${traceIdHex}:ai.agent:${groupKey}`)}${stableHashHex(`lemma:${traceIdHex}:parent:${groupKey}`)}`;
  if (!existing.has(candidate)) {
    return candidate;
  }
  let salt = 1;
  while (existing.has(candidate)) {
    candidate = `${stableHashHex(`${traceIdHex}:ai.agent:${groupKey}:${salt}`)}${stableHashHex(`lemma:${traceIdHex}:parent:${groupKey}:${salt}`)}`;
    salt += 1;
  }
  return candidate;
}

function addSyntheticStreamTextParents(
  request: ProtoExportTraceServiceRequest,
  existingSpanIds: Set<string>,
): {
  parentsAdded: number;
  parentSpanIdByGroup: Map<string, string>;
  originalTraceIdByGroup: Map<string, string>;
} {
  type SpanRef = { span: ProtoSpan; scopeSpan: ProtoScopeSpan };
  const streamTextRefsByGroup = new Map<string, SpanRef[]>();

  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        if (span.name !== AI_STREAM_TEXT) continue;
        const groupKey = getStreamTextGroupKey(span);
        if (!groupKey) continue;
        const refs = streamTextRefsByGroup.get(groupKey);
        const ref: SpanRef = { span, scopeSpan };
        if (refs) refs.push(ref);
        else streamTextRefsByGroup.set(groupKey, [ref]);
      }
    }
  }

  let parentsAdded = 0;
  const parentSpanIdByGroup = new Map<string, string>();
  const originalTraceIdByGroup = new Map<string, string>();
  for (const [groupKey, refs] of streamTextRefsByGroup.entries()) {
    if (refs.length === 0) continue;
    const traceIdHex = bytesToHex(refs[0]!.span.traceId);
    if (!traceIdHex) continue;
    const agentName = getAgentNameForGrouping(refs[0]!.span);
    refs.sort((left, right) => {
      const startLeft = spanStartNs(left.span);
      const startRight = spanStartNs(right.span);
      if (startLeft !== startRight) return startLeft - startRight;
      const idLeft = bytesToHex(left.span.spanId);
      const idRight = bytesToHex(right.span.spanId);
      return idLeft.localeCompare(idRight);
    });

    const syntheticParentSpanIdHex = uniqueSyntheticStreamParentSpanId(
      traceIdHex,
      groupKey,
      existingSpanIds,
    );
    existingSpanIds.add(syntheticParentSpanIdHex);

    const starts = refs
      .map((ref) => spanStartNs(ref.span))
      .filter((value) => value > 0);
    const ends = refs
      .map((ref) => spanEndNs(ref.span))
      .filter((value) => value > 0);
    const startTime = starts.length > 0 ? Math.min(...starts) : undefined;
    const endTime = ends.length > 0 ? Math.max(...ends) : undefined;
    const firstStreamText = refs[0]!.span;
    const lastStreamText = refs.reduce((best, ref) => {
      const bestEnd = spanEndNs(best.span);
      const currentEnd = spanEndNs(ref.span);
      if (currentEnd !== bestEnd) {
        return currentEnd > bestEnd ? ref : best;
      }
      const bestStart = spanStartNs(best.span);
      const currentStart = spanStartNs(ref.span);
      if (currentStart !== bestStart) {
        return currentStart > bestStart ? ref : best;
      }
      return bytesToHex(ref.span.spanId).localeCompare(bytesToHex(best.span.spanId)) > 0
        ? ref
        : best;
    }, refs[0]!);
    const carriedAttributes = collectAgentCarryAttributes(
      firstStreamText,
      lastStreamText.span,
    );
    const aiAgentInputOutput = toAgentInputOutputAttributes(
      firstStreamText,
      lastStreamText.span,
    );
    const threadIdAttributes = toAgentThreadIdAttribute(
      refs.map((ref) => ref.span),
    );
    const agentNameAttributes = toCanonicalAgentNameAttribute(agentName);
    const invariantMetadata = collectInvariantMetadataAttributes(
      refs.map((ref) => ref.span),
    );
    const baseAttributes: ProtoKeyValue[] = [
      {
        key: "operation.name",
        value: { stringValue: AI_STREAM_TEXT_PARENT },
      },
      {
        key: "ai.operationId",
        value: { stringValue: AI_AGENT_OPERATION_ID },
      },
      {
        key: "lemma.synthetic",
        value: { boolValue: true },
      },
      {
        key: "lemma.synthetic.kind",
        value: { stringValue: "stream_parent" },
      },
      {
        key: "span.type",
        value: { stringValue: "agent" },
      },
      {
        key: "openinference.span.kind",
        value: { stringValue: "agent" },
      },
    ];

    const syntheticParentSpan: ProtoSpan = {
      traceId: hexToBytes(traceIdHex),
      spanId: hexToBytes(syntheticParentSpanIdHex),
      parentSpanId: new Uint8Array(),
      name: AI_STREAM_TEXT_PARENT,
      kind: 1,
      startTimeUnixNano: startTime ? String(startTime) : undefined,
      endTimeUnixNano: endTime ? String(endTime) : undefined,
      attributes: mergeAttributesByKey(
        invariantMetadata,
        threadIdAttributes,
        agentNameAttributes,
        aiAgentInputOutput,
        carriedAttributes,
        baseAttributes,
      ),
    };

    refs[0]!.scopeSpan.spans = [...(refs[0]!.scopeSpan.spans ?? []), syntheticParentSpan];
    parentSpanIdByGroup.set(groupKey, syntheticParentSpanIdHex);
    originalTraceIdByGroup.set(groupKey, traceIdHex);

    for (const ref of refs) {
      ref.span.parentSpanId = hexToBytes(syntheticParentSpanIdHex);
    }
    parentsAdded += 1;
  }

  return { parentsAdded, parentSpanIdByGroup, originalTraceIdByGroup };
}

function reparentTopLevelAiSpansUnderAgent(
  request: ProtoExportTraceServiceRequest,
  parentSpanIdByGroup: Map<string, string>,
): void {
  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        if (span.name === AI_STREAM_TEXT_PARENT) continue;
        if (typeof span.name !== "string" || !span.name.startsWith(AI_SPAN_PREFIX)) continue;
        const traceIdHex = bytesToHex(span.traceId);
        if (!traceIdHex) continue;
        if (bytesToHex(span.parentSpanId) !== "") continue;
        const groupKey = makeAgentGroupKey(
          traceIdHex,
          "",
          getAgentNameForGrouping(span),
          getSessionIdForGrouping(span),
        );
        const agentSpanIdHex = parentSpanIdByGroup.get(groupKey);
        if (!agentSpanIdHex) continue;
        span.parentSpanId = hexToBytes(agentSpanIdHex);
      }
    }
  }
}

function rewriteGroupedTraceIds(
  request: ProtoExportTraceServiceRequest,
  parentSpanIdByGroup: Map<string, string>,
  originalTraceIdByGroup: Map<string, string>,
): void {
  const childrenByParent = new Map<string, ProtoSpan[]>();
  const spanById = new Map<string, ProtoSpan>();

  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const spanIdHex = bytesToHex(span.spanId);
        if (spanIdHex) {
          spanById.set(spanIdHex, span);
        }
        const parentSpanIdHex = bytesToHex(span.parentSpanId);
        if (!parentSpanIdHex) continue;
        const children = childrenByParent.get(parentSpanIdHex);
        if (children) children.push(span);
        else childrenByParent.set(parentSpanIdHex, [span]);
      }
    }
  }

  const groupsByOriginalTrace = new Map<string, string[]>();
  for (const [groupKey, originalTraceIdHex] of originalTraceIdByGroup.entries()) {
    const groupKeys = groupsByOriginalTrace.get(originalTraceIdHex);
    if (groupKeys) groupKeys.push(groupKey);
    else groupsByOriginalTrace.set(originalTraceIdHex, [groupKey]);
  }

  for (const [groupKey, agentSpanIdHex] of parentSpanIdByGroup.entries()) {
    const agentSpan = spanById.get(agentSpanIdHex);
    const originalTraceIdHex = originalTraceIdByGroup.get(groupKey);
    if (!agentSpan || !originalTraceIdHex) continue;
    const groupCount = groupsByOriginalTrace.get(originalTraceIdHex)?.length ?? 0;
    if (groupCount <= 1) continue;

    const nextTraceId = hexToBytes(derivedTraceIdHex(groupKey));
    const stack = [agentSpan];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const span = stack.pop()!;
      const spanIdHex = bytesToHex(span.spanId);
      if (spanIdHex) {
        if (visited.has(spanIdHex)) continue;
        visited.add(spanIdHex);
      }
      span.traceId = nextTraceId;
      for (const child of childrenByParent.get(spanIdHex) ?? []) {
        stack.push(child);
      }
    }
  }
}

export interface SyntheticToolSpanStats {
  synthetic_tool_spans_added: number;
  processor_tool_spans_removed: number;
  ai_streamtext_spans_merged: number;
  ai_streamtext_parents_added: number;
  missing_parent_refs_stripped: number;
  non_ai_spans_removed: number;
}

export function applySyntheticToolSpans(
  request: ProtoExportTraceServiceRequest,
): { request: ProtoExportTraceServiceRequest; stats: SyntheticToolSpanStats } {
  const stats: SyntheticToolSpanStats = {
    synthetic_tool_spans_added: 0,
    processor_tool_spans_removed: 0,
    ai_streamtext_spans_merged: 0,
    ai_streamtext_parents_added: 0,
    missing_parent_refs_stripped: 0,
    non_ai_spans_removed: 0,
  };

  const existingSpanIds = new Set<string>();
  const spanById = new Map<string, ProtoSpan>();

  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const spanIdHex = bytesToHex(span.spanId);
        if (!spanIdHex) continue;
        existingSpanIds.add(spanIdHex);
        spanById.set(spanIdHex, span);
      }
    }
  }
  const toolResultsByStreamTextScope = buildToolResultsByStreamTextScope(request);

  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      const spans = scopeSpan.spans ?? [];
      const syntheticToAdd: ProtoSpan[] = [];

      for (const span of spans) {
        if (span.name !== AI_STREAM_TEXT_DO_STREAM) continue;
        const doStreamSpanIdHex = bytesToHex(span.spanId);
        const traceIdHex = bytesToHex(span.traceId);
        if (!doStreamSpanIdHex || !traceIdHex) continue;

        const parentStreamText = spanById.get(bytesToHex(span.parentSpanId));
        const responseToolCallsRaw = getStringAttribute(
          span,
          RESPONSE_TOOL_CALLS_ATTR,
        );
        const responseToolCalls = parseResponseToolCalls(responseToolCallsRaw);
        if (responseToolCalls.length === 0) continue;

        // Optional enrichment: attach result when same tool call id appears as a
        // tool-result in prompt history.
        const promptRaw =
          getStringAttribute(span, "ai.prompt") ??
          (parentStreamText?.name === AI_STREAM_TEXT
            ? getStringAttribute(parentStreamText, "ai.prompt")
            : undefined);
        const promptCalls = parsePromptToolCalls(promptRaw);
        const promptById = new Map(promptCalls.map((call) => [call.id, call]));
        const groupResultsById =
          parentStreamText?.name === AI_STREAM_TEXT
            ? toolResultsByStreamTextScope.byGroup.get(
                getStreamTextGroupKey(parentStreamText) ?? "",
              )
            : undefined;
        const scopedResultsById =
          parentStreamText?.name === AI_STREAM_TEXT
            ? toolResultsByStreamTextScope.byResultScope.get(
                getToolResultScopeKey(parentStreamText) ?? "",
              )
            : undefined;
        const toolCalls = responseToolCalls.map((call) => ({
          ...call,
          result:
            promptById.get(call.id)?.result ??
            groupResultsById?.get(call.id)?.result ??
            scopedResultsById?.get(call.id)?.result,
        }));
        if (toolCalls.length === 0) continue;

        const doStreamStart = toNumber(span.startTimeUnixNano);
        const doStreamEnd = toNumber(span.endTimeUnixNano);
        const hasRange = doStreamStart > 0 && doStreamEnd > doStreamStart;
        const range = hasRange ? doStreamEnd - doStreamStart : 0;
        const chunk = hasRange
          ? Math.max(1, Math.floor(range / Math.max(1, toolCalls.length)))
          : 0;

        toolCalls.forEach((toolCall, index) => {
          const syntheticSpanIdHex = uniqueSyntheticSpanId(
            traceIdHex,
            doStreamSpanIdHex,
            toolCall.id,
            existingSpanIds,
            index,
          );
          existingSpanIds.add(syntheticSpanIdHex);

          const start = hasRange ? doStreamStart + chunk * index : doStreamEnd || doStreamStart || 0;
          const end = hasRange
            ? index === toolCalls.length - 1
              ? doStreamEnd
              : Math.min(doStreamEnd, start + chunk)
            : start;

          const syntheticSpan: ProtoSpan = {
            traceId: hexToBytes(traceIdHex),
            spanId: hexToBytes(syntheticSpanIdHex),
            parentSpanId: hexToBytes(doStreamSpanIdHex),
            name: AI_TOOLCALL_SPAN_NAME,
            kind: 1,
            startTimeUnixNano: start > 0 ? String(start) : undefined,
            endTimeUnixNano: end > 0 ? String(end) : undefined,
          };
          setSyntheticAttributes(syntheticSpan, toolCall);
          syntheticToAdd.push(syntheticSpan);
          stats.synthetic_tool_spans_added += 1;
        });
      }

      if (syntheticToAdd.length > 0) {
        spans.push(...syntheticToAdd);
      }

      if (spans.length > 0) {
        const filtered = spans.filter((span) => {
          const removeToolInfra =
            span.name === PROCESSOR_TOOL ||
            (typeof span.name === "string" &&
              span.name.startsWith(EXECUTE_TOOL_PREFIX));
          if (removeToolInfra) {
            stats.processor_tool_spans_removed += 1;
            return false;
          }
          if (
            typeof span.name === "string" &&
            span.name.startsWith(AI_GENERATE_OBJECT_PREFIX)
          ) {
            stats.non_ai_spans_removed += 1;
            return false;
          }
          const keepAiSdkOrSynthetic =
            typeof span.name === "string" &&
            span.name.startsWith(AI_SPAN_PREFIX);
          if (!keepAiSdkOrSynthetic) {
            stats.non_ai_spans_removed += 1;
            return false;
          }
          return true;
        });
        scopeSpan.spans = filtered;
      }
    }
  }

  const strippedBeforeMerge = stripMissingParentRefs(request);
  const { parentsAdded, parentSpanIdByGroup, originalTraceIdByGroup } =
    addSyntheticStreamTextParents(request, existingSpanIds);
  stats.ai_streamtext_parents_added = parentsAdded;
  reparentTopLevelAiSpansUnderAgent(request, parentSpanIdByGroup);
  rewriteGroupedTraceIds(request, parentSpanIdByGroup, originalTraceIdByGroup);
  const strippedAfterParenting = stripMissingParentRefs(request);
  stats.missing_parent_refs_stripped =
    strippedBeforeMerge + strippedAfterParenting;

  return { request, stats };
}

function stripMissingParentRefs(request: ProtoExportTraceServiceRequest): number {
  type SpanRef = { span: ProtoSpan };
  const byTrace = new Map<string, SpanRef[]>();

  for (const resourceSpan of request.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const traceIdHex = bytesToHex(span.traceId);
        if (!traceIdHex) continue;
        const refs = byTrace.get(traceIdHex);
        const ref: SpanRef = { span };
        if (refs) refs.push(ref);
        else byTrace.set(traceIdHex, [ref]);
      }
    }
  }

  let stripped = 0;
  for (const refs of byTrace.values()) {
    const spanIds = new Set(
      refs.map((ref) => bytesToHex(ref.span.spanId)).filter(Boolean),
    );
    for (const ref of refs) {
      const parentId = bytesToHex(ref.span.parentSpanId);
      if (!parentId) continue;
      if (!spanIds.has(parentId)) {
        ref.span.parentSpanId = new Uint8Array();
        stripped += 1;
      }
    }
  }
  return stripped;
}
