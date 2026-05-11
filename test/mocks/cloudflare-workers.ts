export class WorkflowEntrypoint<TEnv = unknown, TParams = unknown> {
  env: TEnv;

  constructor(env: TEnv) {
    this.env = env;
  }

  async run(_event: unknown, _step: unknown): Promise<TParams | unknown> {
    throw new Error("run() not implemented in test mock");
  }
}
