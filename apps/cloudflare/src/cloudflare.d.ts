// The few pieces of the Cloudflare Workers runtime this app uses, declared
// here so the project type-checks without pulling in the full runtime types.
declare module "cloudflare:workers" {
  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
    deleteAll(): Promise<void>;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  }
  export interface DurableObjectState {
    storage: DurableObjectStorage;
  }
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    protected ctx: DurableObjectState;
    protected env: Env;
  }
}
