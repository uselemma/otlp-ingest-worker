import type { Env } from "../config";
import type { ProtoExportTraceServiceRequest } from "../otel/decode";
import { noopSolution } from "./noop";
import { processorBufferedReparentSolution } from "./processor-buffered-reparent";
import routingConfig from "./routing.json";

/**
 * Context handed to an FDE solution. Solutions receive the unmodified `Request`
 * (auth has already been validated and the project_id has been parsed) and are
 * expected to return the response that will be sent to the OTLP client.
 *
 * The body has not been read yet; solutions decide whether to consume it.
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
 * an entry in `routing.json`, the solution's `handle` is invoked instead of the
 * standard ingest pipeline.
 */
export interface FdeSolution {
  /** Stable identifier referenced from `routing.json`. */
  name: string;
  /** Short human description, surfaced in logs. */
  description: string;
  handle: SolutionHandler;
}

/**
 * Registry of every FDE solution available to the router. Add new solutions
 * here; the `name` must match the `solution` field in `routing.json`.
 */
const SOLUTIONS: readonly FdeSolution[] = [
  noopSolution,
  processorBufferedReparentSolution,
];

const SOLUTIONS_BY_NAME = new Map<string, FdeSolution>(
  SOLUTIONS.map((solution) => [solution.name, solution]),
);

interface CompiledRoute {
  solution: FdeSolution;
  projectIds: Set<string>;
}

function buildRoutes(): CompiledRoute[] {
  return routingConfig.routes.map((route) => {
    const solution = SOLUTIONS_BY_NAME.get(route.solution);
    if (!solution) {
      throw new Error(
        `fde_solutions: unknown solution '${route.solution}'. Known: ${[...SOLUTIONS_BY_NAME.keys()].join(", ") || "(none)"}`,
      );
    }
    return {
      solution,
      projectIds: new Set(
        route.project_ids.map((projectId) => projectId.toLowerCase()),
      ),
    };
  });
}

let compiledRoutes: CompiledRoute[] | null = null;

function getRoutes(): CompiledRoute[] {
  if (!compiledRoutes) {
    compiledRoutes = buildRoutes();
  }
  return compiledRoutes;
}

/**
 * Returns the FDE solution that should handle this request, if any. Routes are
 * evaluated top-to-bottom; the first project_id match wins.
 */
export function resolveSolutionForProject(
  projectId: string,
): FdeSolution | null {
  const normalized = projectId.toLowerCase();
  for (const route of getRoutes()) {
    if (route.projectIds.has(normalized)) {
      return route.solution;
    }
  }
  return null;
}

/** Test-only: drop the cached parse so a different routing.json can be loaded. */
export function __resetFdeRoutingCacheForTesting(): void {
  compiledRoutes = null;
}
