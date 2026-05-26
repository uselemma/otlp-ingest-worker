import type { FdeSolution, SolutionContext } from "../router";
import type { TraceBufferAppendRequest } from "./durable-objects/trace-buffer.types";
import { groupByTraceId } from "./transforms/group-by-trace";

const MAX_TRACE_GROUPS_PER_REQUEST = 100;
const DEFAULT_DEBUG_PAYLOAD_PREFIX = "debug/processor-buffered-reparent";

function isDebugPayloadArchiveEnabled(ctx: SolutionContext): boolean {
  return ctx.env.PROCESSOR_BUFFERED_REPARENT_DEBUG_PAYLOADS === "true";
}

function getDebugPayloadPrefix(ctx: SolutionContext): string {
  return (
    ctx.env.PROCESSOR_BUFFERED_REPARENT_DEBUG_PAYLOAD_PREFIX?.trim() ||
    DEFAULT_DEBUG_PAYLOAD_PREFIX
  ).replace(/^\/+|\/+$/g, "");
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]/g, "_");
}

async function archiveRawIngestPayload(
  ctx: SolutionContext,
  payload: unknown,
  groups: ReturnType<typeof groupByTraceId>,
): Promise<void> {
  if (!isDebugPayloadArchiveEnabled(ctx)) {
    return;
  }
  if (groups.length === 0) {
    return;
  }

  const timestamp = Date.now();
  const traceKey =
    groups.length === 1 ? groups[0]!.traceIdHex : `multi-${groups.length}`;
  const key = `${getDebugPayloadPrefix(ctx)}/${sanitizeKeyPart(ctx.projectId)}/${sanitizeKeyPart(traceKey)}/${timestamp}-raw-ingest.json`;

  try {
    await ctx.env.OTEL_BUCKET.put(
      key,
      new TextEncoder().encode(
        JSON.stringify({
          stage: "raw-ingest",
          projectId: ctx.projectId,
          requestedAt: ctx.requestedAt,
          groupCount: groups.length,
          traceIds: groups.map((group) => group.traceIdHex),
          payload,
        }),
      ),
      {
        customMetadata: {
          project_id: ctx.projectId,
          stage: "raw-ingest",
          requested_at: ctx.requestedAt,
          group_count: String(groups.length),
          trace_ids: groups.map((group) => group.traceIdHex).join(","),
        },
        httpMetadata: {
          contentType: "application/json",
        },
      },
    );
  } catch (error) {
    console.warn("fde_solution.processor-buffered-reparent.raw_payload_write_failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function appendTraceGroup(
  ctx: SolutionContext,
  payload: TraceBufferAppendRequest,
): Promise<void> {
  const id = ctx.env.TRACE_BUFFER.idFromName(
    `${payload.projectId}:${payload.traceIdHex}`,
  );
  const stub = ctx.env.TRACE_BUFFER.get(id);
  const response = await stub.fetch("https://trace-buffer.internal/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Trace buffer append failed (${response.status}): ${detail || "no detail"}`,
    );
  }
}

export const processorBufferedReparentSolution: FdeSolution = {
  name: "processor-buffered-reparent",
  description:
    "Buffer spans by trace in a Durable Object and reparent Processor.tool on flush",
  async handle(ctx) {
    const parsed = await ctx.decodeRequest();
    const groups = groupByTraceId(parsed);
    await archiveRawIngestPayload(ctx, parsed, groups);
    if (groups.length > MAX_TRACE_GROUPS_PER_REQUEST) {
      console.log("fde_solution.processor-buffered-reparent.bypass", {
        project_id: ctx.projectId,
        group_count: groups.length,
        max_groups: MAX_TRACE_GROUPS_PER_REQUEST,
      });
      return ctx.runStandardIngest(parsed);
    }

    await Promise.all(
      groups.map((group) =>
        appendTraceGroup(ctx, {
          projectId: ctx.projectId,
          traceIdHex: group.traceIdHex,
          requestedAt: ctx.requestedAt,
          records: group.records,
        }),
      ),
    );

    return new Response(null, { status: 200 });
  },
};
