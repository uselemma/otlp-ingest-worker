import type { Env } from "../../../config";
import type { ProtoExportTraceServiceRequest } from "../../../otel/decode";
import { runStandardIngest } from "../../../pipeline/run-standard-ingest";
import { applySyntheticToolSpans } from "../transforms/synthetic-tool-spans";
import { isCompletingSpan } from "../transforms/completion-detector";
import type {
  StoredResource,
  StoredScope,
  StoredSpanEntry,
  StoredSpanR2Entry,
  TraceBufferAppendRequest,
  TraceBufferMetaState,
} from "./trace-buffer.types";

const META_STATE_KEY = "meta:state";
const RESOURCE_PREFIX = "meta:resource:";
const SCOPE_PREFIX = "meta:scope:";
const SPAN_PREFIX = "span:";

const DEBOUNCE_MS = 30_000;
const DEFAULT_MAX_BUFFER_MS = 600_000;
const DEFAULT_MAX_SPANS_PER_TRACE = 5_000;
const DEFAULT_MAX_DISPATCH_RETRIES = 5;
const MAX_INLINE_STORED_SPAN_ENTRY_BYTES = 512_000;

function getNumberVar(
  value: string | undefined,
  fallback: number,
  minimum = 1,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForFingerprint(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeForFingerprint(item)]),
  );
}

function fingerprint(value: unknown): string {
  return JSON.stringify(normalizeForFingerprint(value));
}

function hexToBytes(value: string | undefined): Uint8Array {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function toFlushBackoffMs(attempt: number): number {
  return Math.min(60_000, 2 ** attempt * 1_000);
}

function utf8Size(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]/g, "_");
}

export class TraceBuffer implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/append") {
      return this.append(request);
    }
    return new Response("Not found", { status: 404 });
  }

  /** WORKER_SHARED_SECRET may be a plain string or a Secrets Store binding. */
  private async resolveWorkerSharedSecret(): Promise<string> {
    const raw = this.env.WORKER_SHARED_SECRET;
    const value =
      typeof raw === "string" ? raw : raw ? await raw.get() : undefined;
    const secret = value?.trim();
    if (!secret) {
      throw new Error("WORKER_SHARED_SECRET is not configured for flush");
    }
    return secret;
  }

  async alarm(): Promise<void> {
    const meta = await this.state.storage.get<TraceBufferMetaState>(META_STATE_KEY);
    if (!meta) {
      return;
    }

    const now = Date.now();
    const isImmediateReason =
      meta.pendingFlushReason === "hard_cap" || meta.pendingFlushReason === "span_cap";
    if (!isImmediateReason && now - meta.lastAppendAt < DEBOUNCE_MS) {
      await this.state.storage.setAlarm(meta.lastAppendAt + DEBOUNCE_MS);
      return;
    }

    const merged = await this.rebuildRequest();
    const { request: transformed, stats } = applySyntheticToolSpans(merged);

    try {
      // The client's token is not buffered for flush time; enqueue as the
      // trusted worker principal (the client was authorized at accept time).
      const workerSharedSecret = await this.resolveWorkerSharedSecret();
      await runStandardIngest({
        env: this.env,
        projectId: meta.projectId,
        requestedAt: new Date().toISOString(),
        parsed: transformed,
        authorization: `Bearer ${workerSharedSecret}`,
      });
      console.log("trace_buffer.flushed", {
        project_id: meta.projectId,
        trace_id: meta.traceIdHex,
        reason: meta.pendingFlushReason,
        spans: meta.spanCount,
        ...stats,
        debounce_ms: DEBOUNCE_MS,
        debounce_flush: true,
        latency_ms: now - meta.firstAppendAt,
      });
      await this.state.storage.deleteAll();
    } catch (error) {
      meta.flushAttempts += 1;
      await this.state.storage.put(META_STATE_KEY, meta);
      const maxRetries = getNumberVar(
        this.env.PROCESSOR_BUFFERED_REPARENT_MAX_DISPATCH_RETRIES,
        DEFAULT_MAX_DISPATCH_RETRIES,
      );
      if (meta.flushAttempts >= maxRetries) {
        const deadLetterKey = await this.writeDeadLetter(meta, transformed);
        console.log("trace_buffer.dead_letter", {
          project_id: meta.projectId,
          trace_id: meta.traceIdHex,
          attempts: meta.flushAttempts,
          dead_letter_key: deadLetterKey,
          ...stats,
          debounce_ms: DEBOUNCE_MS,
          debounce_flush: true,
        });
        await this.state.storage.deleteAll();
      } else {
        const retryAt = Date.now() + toFlushBackoffMs(meta.flushAttempts);
        console.log("trace_buffer.dispatch_failed", {
          project_id: meta.projectId,
          trace_id: meta.traceIdHex,
          attempt: meta.flushAttempts,
          error: error instanceof Error ? error.message : String(error),
          retry_at_ms: retryAt,
        });
        await this.state.storage.setAlarm(retryAt);
      }
    }
  }

  private async append(request: Request): Promise<Response> {
    const payload = (await request.json()) as TraceBufferAppendRequest;
    if (!payload.projectId || !payload.traceIdHex) {
      return new Response(
        JSON.stringify({ detail: "projectId and traceIdHex are required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const now = Date.now();
    const meta =
      (await this.state.storage.get<TraceBufferMetaState>(META_STATE_KEY)) ?? {
        projectId: payload.projectId,
        traceIdHex: payload.traceIdHex,
        firstAppendAt: now,
        lastAppendAt: now,
        spanCount: 0,
        isComplete: false,
        flushAttempts: 0,
        pendingFlushReason: "inactivity",
      };

    const writes: Record<string, unknown> = {};
    let newSpans = 0;
    let traceCompleted = meta.isComplete;

    for (const record of payload.records) {
      const spanKey = `${SPAN_PREFIX}${record.span.spanId}`;
      const existing = await this.state.storage.get<StoredSpanEntry>(spanKey);
      const resourceFp = fingerprint(record.resource ?? {});
      const scopeFp = fingerprint(record.scope ?? {});
      const inlineEntry = {
        span: record.span,
        resourceFp,
        scopeFp,
      } satisfies StoredSpanEntry;
      if (utf8Size(inlineEntry) > MAX_INLINE_STORED_SPAN_ENTRY_BYTES) {
        const spanR2Key = await this.writeOversizedSpanEntry({
          ...inlineEntry,
          resource: record.resource,
          scope: record.scope,
        });
        writes[spanKey] = {
          spanR2Key,
          resourceFp,
          scopeFp,
        } satisfies StoredSpanEntry;
      } else {
        writes[`${RESOURCE_PREFIX}${resourceFp}`] = record.resource;
        writes[`${SCOPE_PREFIX}${scopeFp}`] = record.scope;
        writes[spanKey] = inlineEntry;
      }
      if (!existing) {
        newSpans += 1;
      }

      const protoSpan = {
        ...record.span,
        traceId: hexToBytes(record.span.traceId),
        spanId: hexToBytes(record.span.spanId),
        parentSpanId: hexToBytes(record.span.parentSpanId),
      };
      if (isCompletingSpan(protoSpan)) {
        traceCompleted = true;
      }
    }

    if (Object.keys(writes).length > 0) {
      await this.state.storage.put(writes);
    }

    meta.lastAppendAt = now;
    meta.spanCount += newSpans;
    meta.isComplete = traceCompleted;
    meta.flushAttempts = 0;

    const maxBufferMs = getNumberVar(
      this.env.PROCESSOR_BUFFERED_REPARENT_MAX_BUFFER_MS,
      DEFAULT_MAX_BUFFER_MS,
    );
    const maxSpans = getNumberVar(
      this.env.PROCESSOR_BUFFERED_REPARENT_MAX_SPANS_PER_TRACE,
      DEFAULT_MAX_SPANS_PER_TRACE,
    );

    const overHardCap = now - meta.firstAppendAt >= maxBufferMs;
    const overSpanCap = meta.spanCount >= maxSpans;
    if (overHardCap) {
      meta.pendingFlushReason = "hard_cap";
      await this.state.storage.setAlarm(now);
    } else if (overSpanCap) {
      meta.pendingFlushReason = "span_cap";
      await this.state.storage.setAlarm(now);
    } else {
      meta.pendingFlushReason = traceCompleted ? "completion" : "inactivity";
      await this.state.storage.setAlarm(now + DEBOUNCE_MS);
    }

    await this.state.storage.put(META_STATE_KEY, meta);

    console.log("fde_solution.processor-buffered-reparent.appended", {
      project_id: payload.projectId,
      trace_id: payload.traceIdHex,
      spans_received: payload.records.length,
      spans_stored: newSpans,
      total_spans: meta.spanCount,
    });

    return new Response(null, { status: 202 });
  }

  private async rebuildRequest(): Promise<ProtoExportTraceServiceRequest> {
    const spanEntries = await this.state.storage.list<StoredSpanEntry>({
      prefix: SPAN_PREFIX,
    });
    const resources = await this.state.storage.list<StoredResource>({
      prefix: RESOURCE_PREFIX,
    });
    const scopes = await this.state.storage.list<StoredScope>({
      prefix: SCOPE_PREFIX,
    });

    const byResourceScope = new Map<
      string,
      {
        resourceFp: string;
        scopeFp: string;
        resource: StoredResource;
        scope: StoredScope;
        spans: NonNullable<StoredSpanEntry["span"]>[];
      }
    >();

    for (const entry of spanEntries.values()) {
      const resolved = await this.resolveStoredSpanEntry(entry);
      const key = `${entry.resourceFp}|${entry.scopeFp}`;
      const existing = byResourceScope.get(key);
      if (existing) {
        existing.spans.push(resolved.span);
      } else {
        byResourceScope.set(key, {
          resourceFp: entry.resourceFp,
          scopeFp: entry.scopeFp,
          resource: resolved.resource,
          scope: resolved.scope,
          spans: [resolved.span],
        });
      }
    }

    return {
      resourceSpans: [...byResourceScope.values()].map((group) => ({
        resource: group.resource ?? resources.get(`${RESOURCE_PREFIX}${group.resourceFp}`),
        scopeSpans: [
          {
            scope: group.scope ?? scopes.get(`${SCOPE_PREFIX}${group.scopeFp}`),
            spans: group.spans.map((span) => ({
              ...span,
              traceId: hexToBytes(span.traceId),
              spanId: hexToBytes(span.spanId),
              parentSpanId: hexToBytes(span.parentSpanId),
            })),
          },
        ],
      })),
    };
  }

  private async writeDeadLetter(
    meta: TraceBufferMetaState,
    request: ProtoExportTraceServiceRequest,
  ): Promise<string> {
    const body = new TextEncoder().encode(JSON.stringify(request));
    const key = `dead-letter/${meta.projectId}/${meta.traceIdHex}/${Date.now()}.json`;
    await this.env.OTEL_BUCKET.put(key, body, {
      customMetadata: {
        project_id: meta.projectId,
        trace_id: meta.traceIdHex,
      },
      httpMetadata: {
        contentType: "application/json",
      },
    });
    return key;
  }

  private async writeOversizedSpanEntry(
    entry: StoredSpanR2Entry,
  ): Promise<string> {
    const key = `trace-buffer-spans/${sanitizeKeyPart(entry.span.traceId)}/${sanitizeKeyPart(entry.span.spanId)}.json`;
    await this.env.OTEL_BUCKET.put(
      key,
      new TextEncoder().encode(JSON.stringify(entry)),
      {
        customMetadata: {
          trace_id: entry.span.traceId,
          span_id: entry.span.spanId,
        },
        httpMetadata: {
          contentType: "application/json",
        },
      },
    );
    return key;
  }

  private async resolveStoredSpanEntry(entry: StoredSpanEntry): Promise<{
    span: NonNullable<StoredSpanEntry["span"]>;
    resource: StoredResource;
    scope: StoredScope;
  }> {
    if (entry.span) {
      return {
        span: entry.span,
        resource: undefined,
        scope: undefined,
      };
    }
    if (!entry.spanR2Key) {
      throw new Error("Stored span entry is missing span and spanR2Key");
    }
    const object = await this.env.OTEL_BUCKET.get(entry.spanR2Key);
    if (!object) {
      throw new Error(`Missing spilled trace-buffer span: ${entry.spanR2Key}`);
    }
    const spilled = JSON.parse(await object.text()) as StoredSpanR2Entry;
    return {
      span: spilled.span,
      resource: spilled.resource,
      scope: spilled.scope,
    };
  }

}
