import type { Env } from "../config";
import type { ProtoExportTraceServiceRequest } from "../otel/decode";

/**
 * Context handed to an FDE solution. Solutions receive the unmodified `Request`
 * (auth has already been validated and the project_id has been parsed) and are
 * expected to return the response that will be sent to the OTLP client.
 *
 * The body has not been read yet — solutions decide whether to consume it.
 */
export interface SolutionContext {
  request: Request;
  env: Env;
  url: URL;
  projectId: string;
  requestedAt: string;
  decodeRequest: () => Promise<ProtoExportTraceServiceRequest>;
  runStandardIngest: (
    parsed: ProtoExportTraceServiceRequest,
  ) => Promise<Response>;
}

export type SolutionHandler = (ctx: SolutionContext) => Promise<Response>;

/**
 * A custom workaround for an individual tenant/project. When a request matches
 * an entry in `routing.toml`, the solution's `handle` is invoked instead of the
 * standard ingest pipeline (decode → R2 → queue).
 */
export interface FdeSolution {
  /** Stable identifier referenced from `routing.toml`. */
  name: string;
  /** Short human description, surfaced in logs. */
  description: string;
  handle: SolutionHandler;
}
