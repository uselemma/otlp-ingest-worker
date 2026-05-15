import { noopSolution } from "./solutions/noop";
import { processorBufferedReparentSolution } from "./solutions/processor-buffered-reparent";
import type { FdeSolution } from "./types";
import routingConfig from "./routing.json";

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
