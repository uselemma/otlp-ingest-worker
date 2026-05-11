import root from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import { describe, expect, it } from "vitest";

import { decodeRequest } from "../../src/otel/decode";

const TRACE_ID = "5b8efff798038103d269b633813fc60c";
const SPAN_ID = "051581bf3cb55c13";
const PARENT_SPAN_ID = "1111111111111111";

function bytesToHex(value: Uint8Array | undefined): string {
  if (!value) return "";
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function messageType() {
  const generatedRoot = (root as { default?: any }).default ?? root;
  return generatedRoot.opentelemetry.proto.collector.trace.v1
    .ExportTraceServiceRequest;
}

function uint8ArrayJson(hexValue: string): Record<string, number> {
  return Object.fromEntries(
    Array.from(hexToBytes(hexValue)).map((byte, index) => [String(index), byte]),
  );
}

function otlpJsonPayload(spanOverrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "worker-test" },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: TRACE_ID,
                  spanId: SPAN_ID,
                  parentSpanId: PARENT_SPAN_ID,
                  name: "json-span",
                  kind: 1,
                  startTimeUnixNano: "10",
                  endTimeUnixNano: "20",
                  attributes: [
                    {
                      key: "ai.agent.input",
                      value: { stringValue: "{\"query\":\"hello\"}" },
                    },
                  ],
                  unknownField: "ignored",
                  ...spanOverrides,
                },
              ],
            },
          ],
        },
      ],
      unknownTopLevelField: "ignored",
    }),
  );
}

function protobufPayload(): Uint8Array {
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "worker-test" },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: hexToBytes(TRACE_ID),
                spanId: hexToBytes(SPAN_ID),
                parentSpanId: hexToBytes(PARENT_SPAN_ID),
                name: "proto-span",
                kind: 1,
                startTimeUnixNano: 10,
                endTimeUnixNano: 20,
              },
            ],
          },
        ],
      },
    ],
  };
  const type = messageType();
  return type.encode(type.fromObject(payload)).finish();
}

describe("decodeRequest", () => {
  it("decodes OTLP JSON with hex trace identifiers", () => {
    const request = decodeRequest(otlpJsonPayload(), "application/json");
    const span = request.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];

    expect(bytesToHex(span?.traceId)).toBe(TRACE_ID);
    expect(bytesToHex(span?.spanId)).toBe(SPAN_ID);
    expect(bytesToHex(span?.parentSpanId)).toBe(PARENT_SPAN_ID);
    expect(span?.name).toBe("json-span");
    expect(span?.kind).toBe(1);
    expect(String(span?.startTimeUnixNano)).toBe("10");
  });

  it("decodes protobufjs object JSON compatibility shapes", () => {
    const request = decodeRequest(
      otlpJsonPayload({
        traceId: uint8ArrayJson(TRACE_ID),
        spanId: {
          type: "Buffer",
          data: Array.from(hexToBytes(SPAN_ID)),
        },
        parentSpanId: Array.from(hexToBytes(PARENT_SPAN_ID)),
        startTimeUnixNano: { high: 414014763, low: 3103809152 },
        endTimeUnixNano: { high: 414014763, low: 3423809152 },
        attributes: [
          {
            key: "large.int",
            value: { intValue: { high: 1, low: 0 } },
          },
          {
            key: "raw.bytes",
            value: { bytesValue: { type: "Buffer", data: [1, 2, 3] } },
          },
        ],
      }),
      "application/json",
    );
    const span = request.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];

    expect(bytesToHex(span?.traceId)).toBe(TRACE_ID);
    expect(bytesToHex(span?.spanId)).toBe(SPAN_ID);
    expect(bytesToHex(span?.parentSpanId)).toBe(PARENT_SPAN_ID);
    expect(String(span?.startTimeUnixNano)).toBe("1778179870250000000");
    expect(String(span?.endTimeUnixNano)).toBe("1778179870570000000");
    expect(String(span?.attributes?.[0]?.value?.intValue)).toBe("4294967296");
    expect(bytesToHex(span?.attributes?.[1]?.value?.bytesValue)).toBe("010203");
  });

  it("defaults legacy payloads without content type to protobuf", () => {
    const request = decodeRequest(protobufPayload());
    const span = request.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];

    expect(bytesToHex(span?.traceId)).toBe(TRACE_ID);
    expect(span?.name).toBe("proto-span");
  });

  it("throws for invalid JSON payloads", () => {
    expect(() =>
      decodeRequest(new TextEncoder().encode("{not-json"), "application/json"),
    ).toThrow("Invalid OTLP payload");
  });
});
