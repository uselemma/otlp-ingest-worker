import root from "@opentelemetry/otlp-transformer/build/src/generated/root.js";

type ProtoAnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number | LongLike;
  doubleValue?: number;
  arrayValue?: { values?: ProtoAnyValue[] };
  kvlistValue?: { values?: ProtoKeyValue[] };
  bytesValue?: Uint8Array;
};

type ProtoKeyValue = {
  key: string;
  value?: ProtoAnyValue;
};

type LongLike = string | { toString: () => string };
type OtlpMessageType = {
  decode: (payload: Uint8Array) => unknown;
  fromObject: (payload: unknown) => unknown;
  toObject: (
    payload: unknown,
    options: { longs: StringConstructor; enums: NumberConstructor; defaults: false },
  ) => unknown;
};

export type ProtoExportTraceServiceRequest = {
  resourceSpans?: Array<{
    resource?: {
      attributes?: ProtoKeyValue[];
    };
    scopeSpans?: Array<{
      scope?: {
        name?: string;
        version?: string;
      };
      spans?: Array<{
        traceId: Uint8Array;
        spanId: Uint8Array;
        parentSpanId?: Uint8Array;
        name?: string;
        kind?: number;
        startTimeUnixNano?: number | LongLike;
        endTimeUnixNano?: number | LongLike;
        attributes?: ProtoKeyValue[];
        status?: {
          code?: number;
          message?: string;
        };
        events?: Array<{
          name?: string;
          timeUnixNano?: number | LongLike;
          attributes?: ProtoKeyValue[];
        }>;
      }>;
    }>;
  }>;
};

const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
const JSON_CONTENT_TYPE = "application/json";
const OTLP_HEX_BYTES_FIELDS = new Set(["traceId", "spanId", "parentSpanId"]);
const OTLP_BYTES_FIELDS = new Set([...OTLP_HEX_BYTES_FIELDS, "bytesValue"]);
const OTLP_INT64_LONG_FIELDS = new Set([
  "endTimeUnixNano",
  "intValue",
  "startTimeUnixNano",
  "timeUnixNano",
]);

function toNumber(value: number | LongLike | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

function bytesToHex(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.length === 0) return "";
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function anyValueToJs(value: ProtoAnyValue | undefined): unknown {
  if (!value) return null;
  if (value.stringValue != null) return value.stringValue;
  if (value.boolValue != null) return value.boolValue;
  if (value.intValue != null) return toNumber(value.intValue);
  if (value.doubleValue != null) return value.doubleValue;
  if (value.bytesValue != null) return bytesToHex(value.bytesValue);
  if (value.arrayValue?.values)
    return value.arrayValue.values.map(anyValueToJs);
  if (value.kvlistValue?.values) {
    return kvsToDict(value.kvlistValue.values);
  }
  return null;
}

function kvsToDict(values: ProtoKeyValue[] = []): Record<string, unknown> {
  return Object.fromEntries(
    values.map((item) => [item.key, anyValueToJs(item.value)]),
  );
}

function parseAgentIoAttributes(attrs: Record<string, unknown>): void {
  for (const key of ["ai.agent.input", "ai.agent.output"]) {
    const value = attrs[key];
    if (typeof value === "string") {
      try {
        attrs[key] = JSON.parse(value);
      } catch {
        // Keep the raw string.
      }
    }
  }
}

function getExportTraceServiceRequestType(): OtlpMessageType {
  const generatedRoot = ((root as { default?: unknown }).default ??
    root) as Record<string, unknown>;
  const traceV1 = (generatedRoot as { opentelemetry?: unknown })
    .opentelemetry as Record<string, unknown>;
  const proto = traceV1.proto as Record<string, unknown>;
  const collector = proto.collector as Record<string, unknown>;
  const trace = collector.trace as Record<string, unknown>;
  const v1 = trace.v1 as Record<string, unknown>;
  return v1.ExportTraceServiceRequest as OtlpMessageType;
}

function normalizeContentType(contentType: string | undefined): string {
  return (contentType ?? PROTOBUF_CONTENT_TYPE)
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new Error("Invalid OTLP hex bytes field");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function isHexString(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value);
}

function protobufjsLongToDecimalString(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const { high, low } = value as { high?: unknown; low?: unknown };
  if (typeof high !== "number" || typeof low !== "number") {
    return undefined;
  }
  return ((BigInt(high >>> 0) << 32n) + BigInt(low >>> 0)).toString();
}

function bytesFromNumberArray(value: unknown): Uint8Array | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return undefined;
  }
  return new Uint8Array(value);
}

function protobufjsBytesToUint8Array(value: unknown): Uint8Array | undefined {
  const arrayBytes = bytesFromNumberArray(value);
  if (arrayBytes) {
    return arrayBytes;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const maybeBuffer = value as { type?: unknown; data?: unknown };
  if (maybeBuffer.type === "Buffer") {
    return bytesFromNumberArray(maybeBuffer.data);
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return undefined;
  }

  const indexedEntries: Array<[number, number]> = [];
  for (const [entryKey, entryValue] of entries) {
    if (!/^\d+$/.test(entryKey)) {
      return undefined;
    }
    if (
      !Number.isInteger(entryValue) ||
      (entryValue as number) < 0 ||
      (entryValue as number) > 255
    ) {
      return undefined;
    }
    indexedEntries.push([Number(entryKey), entryValue as number]);
  }

  indexedEntries.sort(([left], [right]) => left - right);
  if (indexedEntries.some(([index], position) => index !== position)) {
    return undefined;
  }
  return new Uint8Array(indexedEntries.map(([, byte]) => byte));
}

function normalizeOtlpJson(value: unknown, key?: string): unknown {
  if (
    typeof value === "string" &&
    key &&
    OTLP_HEX_BYTES_FIELDS.has(key) &&
    isHexString(value)
  ) {
    return hexToBytes(value);
  }
  if (key && OTLP_BYTES_FIELDS.has(key)) {
    const bytesValue = protobufjsBytesToUint8Array(value);
    if (bytesValue) {
      return bytesValue;
    }
  }
  if (key && OTLP_INT64_LONG_FIELDS.has(key)) {
    const decimalValue = protobufjsLongToDecimalString(value);
    if (decimalValue != null) {
      return decimalValue;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOtlpJson(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      normalizeOtlpJson(entryValue, entryKey),
    ]),
  );
}

function toRequestObject(decoded: unknown): ProtoExportTraceServiceRequest {
  const messageType = getExportTraceServiceRequestType();
  return messageType.toObject(decoded, {
    longs: String,
    enums: Number,
    defaults: false,
  }) as ProtoExportTraceServiceRequest;
}

export function decodeRequest(
  payloadBytes: Uint8Array,
  contentType = PROTOBUF_CONTENT_TYPE,
): ProtoExportTraceServiceRequest {
  try {
    const messageType = getExportTraceServiceRequestType();
    if (normalizeContentType(contentType) === JSON_CONTENT_TYPE) {
      const payloadText = new TextDecoder().decode(payloadBytes);
      const payloadJson = JSON.parse(payloadText) as unknown;
      const normalized = normalizeOtlpJson(payloadJson);
      return toRequestObject(messageType.fromObject(normalized));
    }

    const decoded = messageType.decode(payloadBytes);
    return toRequestObject(decoded);
  } catch {
    throw new Error("Invalid OTLP payload");
  }
}

export { parseAgentIoAttributes, kvsToDict, bytesToHex, toNumber };
