import { describe, expect, it } from "vitest";

import { reparentToolSpans } from "../../../src/fde_solutions/transforms/reparent-tool-spans";
import { bytesToHex, type ProtoExportTraceServiceRequest } from "../../../src/otel/decode";

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function findSpan(
  request: ProtoExportTraceServiceRequest,
  name: string,
): NonNullable<
  NonNullable<
    NonNullable<ProtoExportTraceServiceRequest["resourceSpans"]>[number]["scopeSpans"]
  >[number]["spans"]
>[number] {
  for (const resourceSpans of request.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        if (span.name === name) return span;
      }
    }
  }
  throw new Error(`missing span ${name}`);
}

describe("reparentToolSpans", () => {
  it("reparents Processor.tool under emitting Processor.generation", () => {
    const orchestrator = hexToBytes("aaaaaaaaaaaaaaaa");
    const generationSpanId = hexToBytes("1111111111111111");
    const streamSpanId = hexToBytes("2222222222222222");
    const doStreamSpanId = hexToBytes("3333333333333333");
    const toolSpanId = hexToBytes("4444444444444444");

    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                  spanId: generationSpanId,
                  parentSpanId: orchestrator,
                  name: "Processor.generation",
                },
                {
                  traceId: hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                  spanId: streamSpanId,
                  parentSpanId: generationSpanId,
                  name: "ai.streamText",
                },
                {
                  traceId: hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                  spanId: doStreamSpanId,
                  parentSpanId: streamSpanId,
                  name: "ai.streamText.doStream",
                  attributes: [
                    {
                      key: "ai.response.finishReason",
                      value: { stringValue: "tool-calls" },
                    },
                    {
                      key: "ai.response.toolCalls",
                      value: {
                        stringValue: JSON.stringify([
                          {
                            toolCallId: "toolu_123",
                            toolName: "run_script",
                          },
                        ]),
                      },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                  spanId: toolSpanId,
                  parentSpanId: orchestrator,
                  name: "Processor.tool",
                  attributes: [
                    {
                      key: "gen_ai.tool.call.id",
                      value: { stringValue: "toolu_123" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = reparentToolSpans(request);
    const toolSpan = findSpan(transformed, "Processor.tool");

    expect(stats).toEqual({
      toolSpansSeen: 1,
      reparented: 1,
      unmatched: 0,
    });
    expect(bytesToHex(toolSpan.parentSpanId)).toBe("1111111111111111");
    expect(
      toolSpan.attributes?.some(
        (attribute) =>
          attribute.key === "lemma.original_parent_span_id" &&
          attribute.value?.stringValue === "aaaaaaaaaaaaaaaa",
      ),
    ).toBe(true);
  });

  it("marks unmatched Processor.tool when generation cannot be found", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("cccccccccccccccccccccccccccccccc"),
                  spanId: hexToBytes("9999999999999999"),
                  parentSpanId: hexToBytes("aaaaaaaaaaaaaaaa"),
                  name: "Processor.tool",
                  attributes: [
                    {
                      key: "gen_ai.tool.call.id",
                      value: { stringValue: "toolu_missing" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = reparentToolSpans(request);
    const toolSpan = findSpan(transformed, "Processor.tool");

    expect(stats).toEqual({
      toolSpansSeen: 1,
      reparented: 0,
      unmatched: 1,
    });
    expect(
      toolSpan.attributes?.some(
        (attribute) =>
          attribute.key === "lemma.reparent.unmatched" &&
          attribute.value?.stringValue === "true",
      ),
    ).toBe(true);
  });
});
