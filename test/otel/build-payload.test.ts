import { describe, expect, it } from "vitest";

import { buildLemmaTracePayload } from "../../src/otel/build-payload";
import type { ProtoExportTraceServiceRequest } from "../../src/otel/decode";
import {
  LEMMA_TRACE_PAYLOAD_FORMAT,
  LEMMA_TRACE_PAYLOAD_VERSION,
} from "../../src/otel/lemma-trace-payload";

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const TRACE_ID = "5b8efff798038103d269b633813fc60c";
const SPAN_ID = "051581bf3cb55c13";

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

describe("buildLemmaTracePayload", () => {
  it("extracts traces + spans from decoded OTLP request", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "svc" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hexToBytes(TRACE_ID),
                  spanId: hexToBytes(SPAN_ID),
                  name: "test-span",
                  kind: 1,
                  startTimeUnixNano: "10",
                  endTimeUnixNano: "20",
                  attributes: [
                    {
                      key: "gen_ai.usage.output_tokens",
                      value: { intValue: 42 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const producedAt = "2026-05-11T20:00:00.000Z";
    const payload = buildLemmaTracePayload(request, PROJECT_ID, producedAt);

    expect(payload).toMatchObject({
      format: LEMMA_TRACE_PAYLOAD_FORMAT,
      version: LEMMA_TRACE_PAYLOAD_VERSION,
      project_id: PROJECT_ID,
      produced_at: producedAt,
      traces: [{ otel_trace_id: TRACE_ID, service_name: "svc" }],
    });
    expect(payload.spans).toHaveLength(1);
    expect(payload.spans[0]).toMatchObject({
      trace_id_hex: TRACE_ID,
      otel_span_id: SPAN_ID,
      name: "test-span",
      output_tokens: 42,
      resource: { "service.name": "svc" },
    });
  });
});
