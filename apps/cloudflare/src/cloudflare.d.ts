// The few pieces of the Cloudflare Workers runtime this app uses, declared
// here so the project type-checks without pulling in the full runtime types.
declare module "cloudflare:workers" {
  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    get<T>(keys: string[]): Promise<Map<string, T>>;
    put(key: string, value: unknown): Promise<void>;
    put(entries: Record<string, unknown>): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(options: { prefix?: string; start?: string; end?: string; limit?: number }): Promise<Map<string, T>>;
    deleteAll(): Promise<void>;
    getAlarm(): Promise<number | null>;
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
