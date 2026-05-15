import type { FdeSolution, SolutionContext } from "../types";
import { groupByTraceId } from "../transforms/group-by-trace";
import type { TraceBufferAppendRequest } from "../durable-objects/trace-buffer.types";

const MAX_TRACE_GROUPS_PER_REQUEST = 100;

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
