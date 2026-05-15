import { describe, expect, it } from "vitest";

import { isCompletingSpan } from "../../../src/fde_solutions/transforms/completion-detector";
import type { ProtoExportTraceServiceRequest } from "../../../src/otel/decode";

type ProtoSpan = NonNullable<
  NonNullable<
    NonNullable<ProtoExportTraceServiceRequest["resourceSpans"]>[number]["scopeSpans"]
  >[number]["spans"]
>[number];

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function buildSpan(name: string, attributes: ProtoSpan["attributes"]): ProtoSpan {
  return {
    traceId: hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    spanId: hexToBytes("1111111111111111"),
    parentSpanId: new Uint8Array(),
    name,
    attributes,
  };
}

describe("isCompletingSpan", () => {
  it("returns true for ai.streamText with langfuse.trace.output", () => {
    const span = buildSpan("ai.streamText", [
      {
        key: "langfuse.trace.output",
        value: { stringValue: "final answer" },
      },
    ]);
    expect(isCompletingSpan(span)).toBe(true);
  });

  it("returns false for ai.streamText without output attribute", () => {
    const span = buildSpan("ai.streamText", [
      {
        key: "langfuse.trace.input",
        value: { stringValue: "prompt" },
      },
    ]);
    expect(isCompletingSpan(span)).toBe(false);
  });

  it("returns false for other span names", () => {
    const span = buildSpan("Processor.generation", [
      {
        key: "langfuse.trace.output",
        value: { stringValue: "final answer" },
      },
    ]);
    expect(isCompletingSpan(span)).toBe(false);
  });
});
