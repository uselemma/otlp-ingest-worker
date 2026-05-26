import type { FdeSolution } from "../router";

/**
 * Drops every payload on the floor. The OTLP client still sees a 200 OK so it
 * doesn't retry, but nothing is decoded, stored in R2, or queued for ingest.
 *
 * Used as a kill-switch for tenants we want to temporarily stop ingesting from
 * without taking their integration offline at the network layer.
 */
export const noopSolution: FdeSolution = {
  name: "noop",
  description: "Accept and discard the OTLP payload (no R2 / no queue)",
  async handle() {
    return new Response(null, { status: 200 });
  },
};
