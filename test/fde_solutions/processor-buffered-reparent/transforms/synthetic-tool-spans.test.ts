import { describe, expect, it } from "vitest";

import { applySyntheticToolSpans } from "../../../../src/fde_solutions/processor-buffered-reparent/transforms/synthetic-tool-spans";
import { bytesToHex, type ProtoExportTraceServiceRequest } from "../../../../src/otel/decode";

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function flattenSpans(
  request: ProtoExportTraceServiceRequest,
): NonNullable<
  NonNullable<
    NonNullable<ProtoExportTraceServiceRequest["resourceSpans"]>[number]["scopeSpans"]
  >[number]["spans"]
> {
  const spans: NonNullable<
    NonNullable<
      NonNullable<ProtoExportTraceServiceRequest["resourceSpans"]>[number]["scopeSpans"]
    >[number]["spans"]
  > = [];
  for (const resourceSpans of request.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        spans.push(span);
      }
    }
  }
  return spans;
}

describe("applySyntheticToolSpans", () => {
  it("creates synthetic tool spans under ai.streamText.doStream and removes processor tool spans", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: hexToBytes("0000000000000000"),
                  name: "ai.streamText",
                  attributes: [
                    {
                      key: "ai.prompt",
                      value: {
                        stringValue: JSON.stringify({
                          messages: [
                            {
                              role: "assistant",
                              content: [
                                {
                                  type: "tool-call",
                                  toolCallId: "toolu_abc",
                                  toolName: "run_script",
                                  args: { x: 1 },
                                },
                              ],
                            },
                            {
                              role: "tool",
                              content: [
                                {
                                  type: "tool-result",
                                  toolCallId: "toolu_abc",
                                  result: { ok: true },
                                },
                              ],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("1111111111111111"),
                  name: "ai.streamText.doStream",
                  startTimeUnixNano: "100",
                  endTimeUnixNano: "200",
                  attributes: [
                    {
                      key: "ai.response.toolCalls",
                      value: {
                        stringValue: JSON.stringify([
                          {
                            toolCallId: "toolu_abc",
                            toolName: "run_script",
                            args: { x: 1 },
                          },
                        ]),
                      },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                  spanId: hexToBytes("3333333333333333"),
                  parentSpanId: hexToBytes("9999999999999999"),
                  name: "Processor.tool",
                },
                {
                  traceId: hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                  spanId: hexToBytes("4444444444444444"),
                  parentSpanId: hexToBytes("3333333333333333"),
                  name: "execute_tool run_script",
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);

    expect(stats.synthetic_tool_spans_added).toBe(1);
    expect(stats.processor_tool_spans_removed).toBe(2);
    expect(spans.some((span) => span.name === "Processor.tool")).toBe(false);
    expect(
      spans.some((span) => span.name?.startsWith("execute_tool ")),
    ).toBe(false);

    const synthetic = spans.find((span) => span.name === "ai.toolCall");
    expect(synthetic).toBeTruthy();
    expect(bytesToHex(synthetic!.parentSpanId)).toBe("2222222222222222");
    expect(
      synthetic!.attributes?.find((attribute) => attribute.key === "operation.name")
        ?.value?.stringValue,
    ).toBe("ai.toolCall");
    expect(
      synthetic!.attributes?.find((attribute) => attribute.key === "ai.operationId")
        ?.value?.stringValue,
    ).toBe("ai.toolCall");
    expect(
      synthetic!.attributes?.find((attribute) => attribute.key === "ai.toolCall.name")
        ?.value?.stringValue,
    ).toBe("run_script");
    expect(
      synthetic!.attributes?.find((attribute) => attribute.key === "ai.toolCall.id")
        ?.value?.stringValue,
    ).toBe("toolu_abc");
    expect(
      synthetic!.attributes?.find((attribute) => attribute.key === "ai.toolCall.args")
        ?.value?.stringValue,
    ).toBe("{\"x\":1}");
    expect(
      synthetic!.attributes?.find((attribute) => attribute.key === "ai.toolCall.result")
        ?.value?.stringValue,
    ).toBe("{\"ok\":true}");
    expect(
      synthetic!.attributes?.some(
        (attribute) =>
          attribute.key === "lemma.synthetic" &&
          attribute.value?.boolValue === true,
      ),
    ).toBe(true);
  });

  it("does not synthesize tool spans from historical prompt-only tool calls", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("abababababababababababababababab"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  attributes: [
                    {
                      key: "ai.prompt",
                      value: {
                        stringValue: JSON.stringify({
                          messages: [
                            {
                              role: "assistant",
                              content: [
                                {
                                  type: "tool-call",
                                  toolCallId: "old_tool_call",
                                  toolName: "context_retrieval",
                                  args: {},
                                },
                              ],
                            },
                            {
                              role: "tool",
                              content: [
                                {
                                  type: "tool-result",
                                  toolCallId: "old_tool_call",
                                  toolName: "context_retrieval",
                                  result: { ok: true },
                                },
                              ],
                            },
                            {
                              role: "user",
                              content: [{ type: "text", text: "hi" }],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("abababababababababababababababab"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("1111111111111111"),
                  name: "ai.streamText.doStream",
                  attributes: [
                    {
                      key: "ai.response.finishReason",
                      value: { stringValue: "stop" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);

    expect(stats.synthetic_tool_spans_added).toBe(0);
    expect(spans.some((span) => span.name === "ai.toolCall")).toBe(false);
  });

  it("enriches synthetic tool spans with results from later ai.streamText prompts in the same group", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("acacacacacacacacacacacacacacacac"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  attributes: [
                    { key: "ai.agent.name", value: { stringValue: "agent-a" } },
                    { key: "session.id", value: { stringValue: "thread-a" } },
                    {
                      key: "ai.prompt",
                      value: {
                        stringValue: JSON.stringify({
                          messages: [{ role: "user", content: [{ type: "text", text: "run" }] }],
                        }),
                      },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("acacacacacacacacacacacacacacacac"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("1111111111111111"),
                  name: "ai.streamText.doStream",
                  startTimeUnixNano: "100",
                  endTimeUnixNano: "200",
                  attributes: [
                    {
                      key: "ai.response.toolCalls",
                      value: {
                        stringValue: JSON.stringify([
                          {
                            toolCallId: "toolu_late",
                            toolName: "bash",
                            args: { command: "echo hi" },
                          },
                        ]),
                      },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("acacacacacacacacacacacacacacacac"),
                  spanId: hexToBytes("3333333333333333"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  attributes: [
                    { key: "ai.agent.name", value: { stringValue: "agent-a" } },
                    { key: "session.id", value: { stringValue: "thread-a" } },
                    {
                      key: "ai.prompt",
                      value: {
                        stringValue: JSON.stringify({
                          messages: [
                            {
                              role: "assistant",
                              content: [
                                {
                                  type: "tool-call",
                                  toolCallId: "toolu_late",
                                  toolName: "bash",
                                  args: { command: "echo hi" },
                                },
                              ],
                            },
                            {
                              role: "tool",
                              content: [
                                {
                                  type: "tool-result",
                                  toolCallId: "toolu_late",
                                  result: { stdout: "hi\n" },
                                },
                              ],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const synthetic = flattenSpans(transformed).find((span) => span.name === "ai.toolCall");

    expect(stats.synthetic_tool_spans_added).toBe(1);
    expect(synthetic).toBeTruthy();
    expect(
      synthetic!.attributes?.find((attribute) => attribute.key === "ai.toolCall.result")
        ?.value?.stringValue,
    ).toBe("{\"stdout\":\"hi\\n\"}");
  });

  it("enriches tool spans from later prompts with different streamText parent groups", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("adadadadadadadadadadadadadadadad"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: hexToBytes("aaaaaaaaaaaaaaaa"),
                  name: "ai.streamText",
                  attributes: [
                    { key: "agent.name", value: { stringValue: "do" } },
                    { key: "session.id", value: { stringValue: "thread-a" } },
                    {
                      key: "ai.response.toolCalls",
                      value: {
                        stringValue: JSON.stringify([
                          {
                            toolCallId: "toolu_cross_parent",
                            toolName: "bash",
                            input: { command: "echo hi" },
                          },
                        ]),
                      },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("adadadadadadadadadadadadadadadad"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("1111111111111111"),
                  name: "ai.streamText.doStream",
                  startTimeUnixNano: "100",
                  endTimeUnixNano: "200",
                  attributes: [
                    {
                      key: "ai.response.toolCalls",
                      value: {
                        stringValue: JSON.stringify([
                          {
                            toolCallId: "toolu_cross_parent",
                            toolName: "bash",
                            input: { command: "echo hi" },
                          },
                        ]),
                      },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("adadadadadadadadadadadadadadadad"),
                  spanId: hexToBytes("3333333333333333"),
                  parentSpanId: hexToBytes("bbbbbbbbbbbbbbbb"),
                  name: "ai.streamText",
                  attributes: [
                    { key: "agent.name", value: { stringValue: "do" } },
                    { key: "session.id", value: { stringValue: "thread-a" } },
                    {
                      key: "ai.prompt",
                      value: {
                        stringValue: JSON.stringify({
                          messages: [
                            {
                              role: "tool",
                              content: [
                                {
                                  type: "tool-result",
                                  toolCallId: "toolu_cross_parent",
                                  toolName: "bash",
                                  output: { type: "text", value: "hi\n" },
                                },
                              ],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const synthetic = flattenSpans(transformed).find((span) => span.name === "ai.toolCall");

    expect(stats.synthetic_tool_spans_added).toBe(1);
    expect(synthetic).toBeTruthy();
    expect(
      synthetic!.attributes?.find((attribute) => attribute.key === "ai.toolCall.result")
        ?.value?.stringValue,
    ).toBe("{\"type\":\"text\",\"value\":\"hi\\n\"}");
  });

  it("keeps individual ai.streamText spans and reparents them under synthetic ai.agent", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                  spanId: hexToBytes("1010101010101010"),
                  parentSpanId: hexToBytes("aaaaaaaaaaaaaaaa"),
                  name: "ai.streamText",
                  startTimeUnixNano: "100",
                  endTimeUnixNano: "200",
                  attributes: [
                    {
                      key: "ai.prompt",
                      value: { stringValue: "first-input" },
                    },
                    {
                      key: "langfuse.trace.input",
                      value: { stringValue: "first-langfuse-input" },
                    },
                    {
                      key: "gen_ai.request.model",
                      value: { stringValue: "gpt-4.1" },
                    },
                    {
                      key: "ai.provider",
                      value: { stringValue: "openai" },
                    },
                    {
                      key: "ai.request.id",
                      value: { stringValue: "req-1" },
                    },
                    {
                      key: "session.id",
                      value: { stringValue: "thread-123" },
                    },
                    {
                      key: "agent.name",
                      value: { stringValue: "do" },
                    },
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "old-output" },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                  spanId: hexToBytes("2020202020202020"),
                  parentSpanId: hexToBytes("aaaaaaaaaaaaaaaa"),
                  name: "ai.streamText",
                  startTimeUnixNano: "300",
                  endTimeUnixNano: "400",
                  attributes: [
                    {
                      key: "ai.prompt",
                      value: { stringValue: "second-input" },
                    },
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "final-output" },
                    },
                    {
                      key: "ai.response.text",
                      value: { stringValue: "final-text" },
                    },
                    {
                      key: "gen_ai.request.model",
                      value: { stringValue: "gpt-4.1" },
                    },
                    {
                      key: "ai.provider",
                      value: { stringValue: "openai" },
                    },
                    {
                      key: "ai.request.id",
                      value: { stringValue: "req-2" },
                    },
                    {
                      key: "session.id",
                      value: { stringValue: "thread-123" },
                    },
                    {
                      key: "agent.name",
                      value: { stringValue: "do" },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                  spanId: hexToBytes("3030303030303030"),
                  parentSpanId: hexToBytes("2020202020202020"),
                  name: "ai.streamText.doStream",
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);
    const streamTexts = spans.filter((span) => span.name === "ai.streamText");
    const parent = spans.find((span) => span.name === "ai.agent");

    expect(stats.ai_streamtext_spans_merged).toBe(0);
    expect(stats.ai_streamtext_parents_added).toBe(1);
    expect(streamTexts).toHaveLength(2);
    expect(parent).toBeTruthy();
    expect(bytesToHex(parent!.parentSpanId)).toBe("");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "ai.prompt")?.value
        ?.stringValue,
    ).toBe("first-input");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "langfuse.trace.input")
        ?.value?.stringValue,
    ).toBe("first-langfuse-input");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "langfuse.trace.output")
        ?.value?.stringValue,
    ).toBe("final-output");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "ai.response.text")
        ?.value?.stringValue,
    ).toBe("final-text");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "ai.operationId")
        ?.value?.stringValue,
    ).toBe("ai.agent.run");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "ai.agent.input")
        ?.value?.stringValue,
    ).toBe("first-langfuse-input");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "ai.agent.output")
        ?.value?.stringValue,
    ).toBe("final-output");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "gen_ai.request.model")
        ?.value?.stringValue,
    ).toBe("gpt-4.1");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "ai.provider")?.value
        ?.stringValue,
    ).toBe("openai");
    expect(
      parent!.attributes?.some((attribute) => attribute.key === "ai.request.id"),
    ).toBe(false);
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "session.id")?.value
        ?.stringValue,
    ).toBe("thread-123");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "lemma.thread_id")
        ?.value?.stringValue,
    ).toBe("thread-123");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "gen_ai.agent.name")
        ?.value?.stringValue,
    ).toBe("do");
    expect(
      parent!.attributes?.some((attribute) => attribute.key === "agent.name"),
    ).toBe(false);
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "span.type")?.value
        ?.stringValue,
    ).toBe("agent");
    expect(
      parent!.attributes?.find(
        (attribute) => attribute.key === "openinference.span.kind",
      )?.value?.stringValue,
    ).toBe("agent");
    for (const streamText of streamTexts) {
      expect(bytesToHex(streamText.parentSpanId)).toBe(bytesToHex(parent!.spanId));
    }
    expect(
      streamTexts[0]?.attributes?.find((attribute) => attribute.key === "ai.prompt")
        ?.value?.stringValue,
    ).toBe("first-input");
    expect(
      streamTexts[1]?.attributes?.find(
        (attribute) => attribute.key === "langfuse.trace.output",
      )?.value?.stringValue,
    ).toBe("final-output");
    expect(
      streamTexts[1]?.attributes?.find((attribute) => attribute.key === "ai.response.text")
        ?.value?.stringValue,
    ).toBe("final-text");

    const doStream = spans.find((span) => span.name === "ai.streamText.doStream");
    expect(bytesToHex(doStream!.parentSpanId)).toBe("2020202020202020");
  });

  it("creates separate synthetic ai.agent spans for different parentSpanId groups", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("cccccccccccccccccccccccccccccccc"),
                  spanId: hexToBytes("aaaaaaaaaaaaaaaa"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.parentA",
                },
                {
                  traceId: hexToBytes("cccccccccccccccccccccccccccccccc"),
                  spanId: hexToBytes("bbbbbbbbbbbbbbbb"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.parentB",
                },
                {
                  traceId: hexToBytes("cccccccccccccccccccccccccccccccc"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: hexToBytes("aaaaaaaaaaaaaaaa"),
                  name: "ai.streamText",
                  attributes: [
                    { key: "ai.prompt", value: { stringValue: "first" } },
                  ],
                },
                {
                  traceId: hexToBytes("cccccccccccccccccccccccccccccccc"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("bbbbbbbbbbbbbbbb"),
                  name: "ai.streamText",
                  attributes: [
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "second" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);
    const streamTexts = spans.filter(
      (span) => span.name === "ai.streamText",
    );
    const parents = spans.filter((span) => span.name === "ai.agent");

    expect(stats.ai_streamtext_spans_merged).toBe(0);
    expect(stats.ai_streamtext_parents_added).toBe(2);
    expect(streamTexts).toHaveLength(2);
    expect(parents).toHaveLength(2);
    expect(bytesToHex(streamTexts[0]!.parentSpanId)).not.toBe(
      bytesToHex(streamTexts[1]!.parentSpanId),
    );
  });

  it("creates separate synthetic ai.agent spans when agent.name differs", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("ababababccccccccddddddddeeeeeeee"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  attributes: [
                    { key: "ai.agent.name", value: { stringValue: "alpha" } },
                    { key: "ai.prompt", value: { stringValue: "first" } },
                  ],
                },
                {
                  traceId: hexToBytes("ababababccccccccddddddddeeeeeeee"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  attributes: [
                    { key: "ai.agent.name", value: { stringValue: "beta" } },
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "second" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);
    const streamTexts = spans.filter((span) => span.name === "ai.streamText");
    const parents = spans.filter((span) => span.name === "ai.agent");

    expect(stats.ai_streamtext_parents_added).toBe(2);
    expect(streamTexts).toHaveLength(2);
    expect(parents).toHaveLength(2);
    expect(bytesToHex(streamTexts[0]!.parentSpanId)).not.toBe(
      bytesToHex(streamTexts[1]!.parentSpanId),
    );
  });

  it("splits emitted traces when session.id differs", () => {
    const originalTraceId = "12121212121212121212121212121212";
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes(originalTraceId),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  attributes: [
                    { key: "ai.agent.name", value: { stringValue: "worker" } },
                    { key: "session.id", value: { stringValue: "session-a" } },
                    { key: "ai.prompt", value: { stringValue: "first" } },
                  ],
                },
                {
                  traceId: hexToBytes(originalTraceId),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("1111111111111111"),
                  name: "ai.streamText.doStream",
                },
                {
                  traceId: hexToBytes(originalTraceId),
                  spanId: hexToBytes("3333333333333333"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  attributes: [
                    { key: "ai.agent.name", value: { stringValue: "worker" } },
                    { key: "session.id", value: { stringValue: "session-b" } },
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "second" },
                    },
                  ],
                },
                {
                  traceId: hexToBytes(originalTraceId),
                  spanId: hexToBytes("4444444444444444"),
                  parentSpanId: hexToBytes("3333333333333333"),
                  name: "ai.streamText.doStream",
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);
    const parents = spans.filter((span) => span.name === "ai.agent");
    const streamTexts = spans.filter((span) => span.name === "ai.streamText");

    expect(stats.ai_streamtext_parents_added).toBe(2);
    expect(parents).toHaveLength(2);
    expect(streamTexts).toHaveLength(2);
    expect(new Set(parents.map((span) => bytesToHex(span.traceId))).size).toBe(2);
    expect(parents.every((span) => bytesToHex(span.traceId) !== originalTraceId)).toBe(
      true,
    );
    for (const streamText of streamTexts) {
      const parent = parents.find(
        (span) => bytesToHex(span.spanId) === bytesToHex(streamText.parentSpanId),
      );
      expect(parent).toBeTruthy();
      expect(bytesToHex(streamText.traceId)).toBe(bytesToHex(parent!.traceId));
    }
  });

  it("uses latest end-time ai.streamText for ai.agent output", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("a1a1a1a1b2b2b2b2c3c3c3c3d4d4d4d4"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  startTimeUnixNano: "100",
                  endTimeUnixNano: "300",
                  attributes: [
                    { key: "ai.prompt", value: { stringValue: "seed-input" } },
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "tool-call-output" },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("a1a1a1a1b2b2b2b2c3c3c3c3d4d4d4d4"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  startTimeUnixNano: "400",
                  endTimeUnixNano: "450",
                  attributes: [
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "short-late-output" },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("a1a1a1a1b2b2b2b2c3c3c3c3d4d4d4d4"),
                  spanId: hexToBytes("3333333333333333"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  startTimeUnixNano: "350",
                  endTimeUnixNano: "900",
                  attributes: [
                    { key: "ai.response.text", value: { stringValue: "final-text" } },
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "final-output" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);
    const parent = spans.find((span) => span.name === "ai.agent");

    expect(parent).toBeTruthy();
    expect(parent!.endTimeUnixNano).toBe("900");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "ai.agent.output")
        ?.value?.stringValue,
    ).toBe("final-output");
    expect(
      parent!.attributes?.find((attribute) => attribute.key === "ai.response.text")
        ?.value?.stringValue,
    ).toBe("final-text");
  });

  it("strips parentSpanId when parent span is missing from payload", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("dddddddddddddddddddddddddddddddd"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: hexToBytes("aaaaaaaaaaaaaaaa"), // missing
                  name: "ai.streamText",
                },
                {
                  traceId: hexToBytes("dddddddddddddddddddddddddddddddd"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("1111111111111111"), // present
                  name: "ai.streamText.doStream",
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);
    const streamText = spans.find((span) => span.name === "ai.streamText");
    const streamParent = spans.find((span) => span.name === "ai.agent");
    const child = spans.find((span) => span.name === "ai.streamText.doStream");

    expect(stats.missing_parent_refs_stripped).toBe(1);
    expect(stats.ai_streamtext_parents_added).toBe(1);
    expect(streamParent).toBeTruthy();
    expect(bytesToHex(streamText!.parentSpanId)).toBe(bytesToHex(streamParent!.spanId));
    expect(bytesToHex(child!.parentSpanId)).toBe("1111111111111111");
  });

  it("removes ai.generateObject spans from output payload", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                  attributes: [
                    { key: "ai.prompt", value: { stringValue: "input" } },
                    {
                      key: "langfuse.trace.output",
                      value: { stringValue: "output" },
                    },
                  ],
                },
                {
                  traceId: hexToBytes("f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("1111111111111111"),
                  name: "ai.streamText.doStream",
                },
                {
                  traceId: hexToBytes("f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"),
                  spanId: hexToBytes("3333333333333333"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.generateObject",
                },
                {
                  traceId: hexToBytes("f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"),
                  spanId: hexToBytes("4444444444444444"),
                  parentSpanId: hexToBytes("3333333333333333"),
                  name: "ai.generateObject.doGenerate",
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const spans = flattenSpans(transformed);
    const parent = spans.find((span) => span.name === "ai.agent");

    expect(parent).toBeTruthy();
    expect(stats.non_ai_spans_removed).toBe(2);
    expect(spans.some((span) => span.name === "ai.generateObject")).toBe(false);
    expect(spans.some((span) => span.name === "ai.generateObject.doGenerate")).toBe(false);
  });

  it("removes non-ai spans from output payload", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: new Uint8Array(),
                  name: "ai.streamText",
                },
                {
                  traceId: hexToBytes("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: hexToBytes("1111111111111111"),
                  name: "ai.streamText.doStream",
                },
                {
                  traceId: hexToBytes("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
                  spanId: hexToBytes("3333333333333333"),
                  parentSpanId: new Uint8Array(),
                  name: "Processor.generation",
                },
                {
                  traceId: hexToBytes("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
                  spanId: hexToBytes("4444444444444444"),
                  parentSpanId: hexToBytes("3333333333333333"),
                  name: "workspace_memory.fetch",
                },
              ],
            },
          ],
        },
      ],
    };

    const { request: transformed, stats } = applySyntheticToolSpans(request);
    const names = flattenSpans(transformed).map((span) => span.name);

    expect(stats.non_ai_spans_removed).toBe(2);
    expect(names).toContain("ai.streamText");
    expect(names).toContain("ai.streamText.doStream");
    expect(names).not.toContain("Processor.generation");
    expect(names).not.toContain("workspace_memory.fetch");
  });
});
