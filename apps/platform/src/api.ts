/**
 * The platform's HTTP API, version 1 (docs/api.md): authentication, routing
 * to each session's engine, idempotency, events by stream or webhook, and the
 * OpenAPI description. It takes a standard `Request` and returns a
 * `Response`, and reaches sessions and integrators only through a
 * `PlatformHost`, so the same code runs on Cloudflare and in tests.
 *
 * Who is calling is established here, from the Authorization header:
 *
 * - `Bearer mk_test_…` / `mk_live_…`: an integrator's API key. Creates and
 *   manages sessions, and owns webhooks.
 * - `Bearer tok_…`: a participant's token, issued on joining, for its own
 *   session only.
 * - nothing: anyone. Enough to join with an invitation and to read what a
 *   session shows the public.
 */
import { MAX_BODY, parseBody, type Reply } from "@mattering/witness/routes";
import { HostedSession, IntegratorDesk, memoryKV, sha256, type DeskCall, type HostedSessionOptions, type SessionCall } from "./hosted.ts";
import { OPENAPI } from "./openapi.ts";
import { newSessionId, sessionOf, type Caller } from "./session.ts";

export interface PlatformHost {
  /** The integrator an API key belongs to, or undefined if it is not a key. */
  integratorOf(apiKey: string): Promise<string | undefined>;
  session(id: string): { call(req: SessionCall): Promise<Reply> };
  desk(integrator: string): { call(req: DeskCall): Promise<Reply> };
  /** Where the API is served from, such as "/api/v1". */
  base: string;
  /** New sessions per integrator per day. */
  sessionsPerDay: number;
  /** Where the public log serves a round's evidence. */
  evidenceUrl?: (policyHash: string) => string;
  /** Event streams: how often to look for new events, and how long to hold a stream open before the client reconnects. */
  stream?: { pollMs: number; holdMs: number };
}

const HEADERS = { "content-type": "application/json", "cache-control": "no-store", "mattering-environment": "demonstration" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + "\n", { status, headers: HEADERS });
}
const problem = (status: number, code: string, message: string): Response => json(status, { error: { code, message } });

const SESSION_PATH = /^\/sessions\/(ses_[0-9a-f]{24})(\/[a-z-]+)?$/;
const WEBHOOK_PATH = /^\/webhooks\/(whk_[0-9a-f]{16})$/;
const API_KEY = /^mk_(?:live|test)_[A-Za-z0-9]{16,64}$/;
const TOKEN = /^tok_[0-9a-f]{24}_[0-9a-f]{32}$/;
/** Engine routes reachable from the API, by method. */
const SESSION_ROUTES: Record<string, string[]> = {
  GET: ["/", "/round", "/result", "/evidence", "/events"],
  POST: ["/join", "/check-in", "/bids", "/open", "/cancel", "/disclose"],
};

async function callerOf(request: Request, host: PlatformHost): Promise<Caller | Response> {
  const header = request.headers.get("authorization");
  if (!header) return { role: "public" };
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) return problem(401, "unauthorised", "Authorization: want Bearer <API key or participant token>");
  const credential = m[1]!;
  if (TOKEN.test(credential)) return { role: "participant", token: credential };
  if (API_KEY.test(credential)) {
    const integrator = await host.integratorOf(credential);
    if (integrator) return { role: "organiser", integrator };
  }
  return problem(401, "unauthorised", "that API key or token is not recognised");
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("request body too large"), { status: 413 });
  return text.trim() === "" ? {} : parseBody(text);
}

/** Add where to fetch each round's evidence to a receipt in the reply. */
function withEvidenceUrls(body: unknown, host: PlatformHost): unknown {
  const receipt = (body as { receipt?: { rounds?: { policyHash: string }[] } } | null)?.receipt;
  if (!host.evidenceUrl || !receipt?.rounds) return body;
  return { ...(body as object), receipt: { ...receipt, rounds: receipt.rounds.map((r) => ({ ...r, evidence: host.evidenceUrl!(r.policyHash) })) } };
}

export async function handleApi(request: Request, host: PlatformHost): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(host.base)) return problem(404, "not-found", "no such route");
  const path = url.pathname.slice(host.base.length) || "/";
  const method = request.method.toUpperCase();
  try {
    if (method === "GET" && path === "/openapi.json") return json(200, OPENAPI);
    if (method === "GET" && path === "/") return json(200, { name: "Mattering platform API", version: "1", environment: "demonstration", openapi: `${host.base}/openapi.json`, note: "Proof of concept, not security reviewed. Results are not legally binding and no payment is made or arranged." });
    const caller = await callerOf(request, host);
    if (caller instanceof Response) return caller;
    const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;

    if (path === "/sessions" && method === "POST") return await createSession(request, host, caller, idempotencyKey);
    if (path === "/join" && method === "POST") {
      // Joining needs only the invitation: it names its session.
      const body = await readJson(request);
      const id = sessionOf((body as { invitation?: unknown }).invitation);
      if (!id || !String((body as { invitation?: unknown }).invitation).startsWith("inv_")) return problem(400, "invalid", "invitation: want an invitation code (inv_…)");
      return forward(host, id, { method: "POST", path: "/join", body, caller, ...(idempotencyKey ? { idempotencyKey } : {}) });
    }
    if (path === "/webhooks" || WEBHOOK_PATH.test(path)) {
      if (caller.role !== "organiser") return problem(401, "unauthorised", "webhooks belong to an integrator: send its API key");
      const desk = host.desk(caller.integrator);
      if (path === "/webhooks" && method === "POST") {
        const body = (await readJson(request)) as { url?: unknown; events?: unknown };
        return reply(await desk.call({ op: "webhook.create", url: body.url, ...(body.events !== undefined ? { events: body.events } : {}) }));
      }
      if (path === "/webhooks" && method === "GET") return reply(await desk.call({ op: "webhook.list" }));
      const hook = WEBHOOK_PATH.exec(path);
      if (hook && method === "DELETE") return reply(await desk.call({ op: "webhook.delete", id: hook[1]! }));
      return problem(405, "method-not-allowed", `${method} is not allowed here`);
    }

    const m = SESSION_PATH.exec(path);
    if (!m) return problem(404, "not-found", "no such route");
    const id = m[1]!;
    const sub = m[2] ?? "/";
    if (!SESSION_ROUTES[method]?.includes(sub)) {
      const known = SESSION_ROUTES.GET!.includes(sub) || SESSION_ROUTES.POST!.includes(sub);
      return known ? problem(405, "method-not-allowed", `${method} is not allowed on ${sub}`) : problem(404, "not-found", `no route ${sub}`);
    }
    if (caller.role === "participant" && sessionOf(caller.token) !== id) return problem(403, "forbidden", "that token is for another session");
    if (sub === "/events" && (request.headers.get("accept") ?? "").includes("text/event-stream")) return stream(host, id, caller, request, url);
    const query = Object.fromEntries(url.searchParams);
    const body = method === "POST" ? await readJson(request) : undefined;
    if (sub === "/join" && sessionOf((body as { invitation?: unknown }).invitation) !== id) return problem(404, "not-found", "that invitation is not for this session");
    return forward(host, id, { method, path: sub, query, ...(body !== undefined ? { body } : {}), caller, ...(idempotencyKey ? { idempotencyKey } : {}) });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 413) return problem(413, "too-large", "request body too large");
    if (error instanceof SyntaxError || (error as { code?: string }).code === "MALFORMED") return problem(400, "invalid", "the body is not valid JSON");
    console.error(error);
    return problem(500, "internal", "internal error");
  }

  async function forward(h: PlatformHost, id: string, req: SessionCall): Promise<Response> {
    const r = await h.session(id).call(req);
    return json(r.status, withEvidenceUrls(r.body, h));
  }
}

function reply(r: Reply): Response {
  return json(r.status, r.body);
}

/** Create a session for the calling integrator: idempotent with a key, and within its daily allowance. */
async function createSession(request: Request, host: PlatformHost, caller: Caller, idempotencyKey: string | undefined): Promise<Response> {
  if (caller.role !== "organiser") return problem(401, "unauthorised", "creating a session needs an integrator's API key");
  const body = (await readJson(request)) as Record<string, unknown>;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return problem(400, "invalid", "want a JSON object");
  const desk = host.desk(caller.integrator);
  let key: string | undefined;
  let fingerprint = "";
  if (idempotencyKey !== undefined) {
    if (idempotencyKey === "" || idempotencyKey.length > 200) return problem(400, "invalid", "Idempotency-Key: want 1 to 200 characters");
    key = await sha256(`create\n${idempotencyKey}`);
    fingerprint = await sha256(JSON.stringify(body));
    const saved = await desk.call({ op: "idem.get", key, fingerprint });
    if (saved.status === 200) return json((saved.body as Reply).status, withEvidenceUrls((saved.body as Reply).body, host));
    if (saved.status === 422) return reply(saved);
  }
  const allowed = await desk.call({ op: "session.allow", perDay: host.sessionsPerDay });
  if (allowed.status !== 200) return reply(allowed);
  // The id is made here, never taken from the caller.
  const id = newSessionId();
  const created = await host.session(id).call({ method: "POST", path: "/create", body: { ...body, id }, caller });
  if (key && created.status < 500) await desk.call({ op: "idem.put", key, fingerprint, reply: created });
  return reply(created);
}

/**
 * A session's events as server-sent events. Starts after `Last-Event-ID` (or
 * `?after=`), sends what is new every `pollMs`, and closes after `holdMs` or
 * once the session has ended; the client reconnects with `Last-Event-ID`.
 */
function stream(host: PlatformHost, id: string, caller: Caller, request: Request, url: URL): Response {
  const { pollMs, holdMs } = host.stream ?? { pollMs: 1000, holdMs: 55_000 };
  let after = Math.max(0, Number(request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0);
  const encoder = new TextEncoder();
  const ended = ["finished", "cancelled", "expired"];
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const until = Date.now() + holdMs;
      controller.enqueue(encoder.encode(`retry: ${Math.max(1000, pollMs)}\n\n`));
      try {
        for (;;) {
          const r = await host.session(id).call({ method: "GET", path: "/events", query: { after: String(after) }, caller });
          if (r.status !== 200) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(r.body)}\n\n`));
            break;
          }
          const { events, phase } = r.body as { events: { n: number; type: string }[]; phase: string };
          for (const e of events) {
            controller.enqueue(encoder.encode(`id: ${e.n}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
            after = e.n;
          }
          if (ended.includes(phase) || Date.now() + pollMs > until) break;
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "mattering-environment": "demonstration" } });
}

/**
 * The whole platform in one process, in memory: for tests, examples and
 * running locally. `keys` maps API keys to integrator names.
 */
export function localPlatform(options: {
  keys: Record<string, string>;
  session: Omit<HostedSessionOptions, "kv" | "webhooks">;
  base?: string;
  sessionsPerDay?: number;
  evidenceUrl?: (policyHash: string) => string;
  stream?: { pollMs: number; holdMs: number };
}) {
  const sessions = new Map<string, Promise<HostedSession>>();
  const desks = new Map<string, IntegratorDesk>();
  const desk = (name: string) => desks.get(name) ?? desks.set(name, new IntegratorDesk(memoryKV())).get(name)!;
  const webhooks = async (integrator: string) => ((await desk(integrator).call({ op: "webhook.secrets" })).body as { webhooks: never[] }).webhooks;
  const open = (id: string) => sessions.get(id) ?? sessions.set(id, HostedSession.open({ ...options.session, kv: memoryKV(), webhooks })).get(id)!;
  const host: PlatformHost = {
    integratorOf: async (key) => options.keys[key],
    session: (id) => ({ call: async (req) => (await open(id)).call(req) }),
    desk: (name) => ({ call: (req) => desk(name).call(req) }),
    base: options.base ?? "/v1",
    sessionsPerDay: options.sessionsPerDay ?? 100,
    ...(options.evidenceUrl ? { evidenceUrl: options.evidenceUrl } : {}),
    ...(options.stream ? { stream: options.stream } : {}),
  };
  return {
    host,
    fetch: (request: Request) => handleApi(request, host),
    /** Do whatever is due in every session, as a host's timers would. */
    async work(): Promise<void> {
      for (const s of sessions.values()) await (await s).work();
    },
  };
}
