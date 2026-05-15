import { describe, expect, it } from "vitest";

import { groupByTraceId } from "../../../src/fde_solutions/transforms/group-by-trace";
import type { ProtoExportTraceServiceRequest } from "../../../src/otel/decode";

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

describe("groupByTraceId", () => {
  it("groups spans by trace id and keeps resource/scope", () => {
    const request: ProtoExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "svc-a" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "scope-a", version: "1.0.0" },
              spans: [
                {
                  traceId: hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                  spanId: hexToBytes("1111111111111111"),
                  parentSpanId: new Uint8Array(),
                  name: "span-a1",
                },
                {
                  traceId: hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                  spanId: hexToBytes("2222222222222222"),
                  parentSpanId: new Uint8Array(),
                  name: "span-b1",
                },
              ],
            },
          ],
        },
      ],
    };

    const grouped = groupByTraceId(request);
    expect(grouped).toHaveLength(2);

    const a = grouped.find(
      (item) => item.traceIdHex === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const b = grouped.find(
      (item) => item.traceIdHex === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    expect(a?.records).toHaveLength(1);
    expect(a?.records[0]?.span.spanId).toBe("1111111111111111");
    expect(a?.records[0]?.resource?.attributes?.[0]?.key).toBe("service.name");
    expect(a?.records[0]?.scope?.name).toBe("scope-a");

    expect(b?.records).toHaveLength(1);
    expect(b?.records[0]?.span.spanId).toBe("2222222222222222");
  });
});
