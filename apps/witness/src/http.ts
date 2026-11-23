/**
 * HTTP front for the witness service and for a cosigner. JSON in, JSON out.
 * Everything served here is public; there is no authentication because there
 * is nothing private to protect. Submissions authenticate themselves by
 * signature.
 */
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { MatteringError, type Checkpoint, type Cosigner, type Envelope, type PolicyTerms, type Submission } from "@mattering/core";
import type { WitnessService } from "./service.ts";

const MAX_BODY = 256 * 1024;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new MatteringError("MALFORMED", "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MatteringError("MALFORMED", "request body is not JSON");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  response.end(JSON.stringify(body) + "\n");
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof MatteringError) {
    const status = (error as { notFound?: boolean }).notFound ? 404 : error.code === "POLICY" ? 409 : error.code === "UNAVAILABLE" ? 503 : 400;
    send(response, status, { error: error.message, code: error.code });
  } else {
    console.error(error);
    send(response, 500, { error: "internal error" });
  }
}

type Handler = (parts: string[], request: IncomingMessage, url: URL) => Promise<unknown> | unknown;

function listener(routes: Record<string, Handler>): RequestListener {
  return (request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean);
        const handler = routes[`${request.method} ${parts[0] ?? ""}`];
        if (!handler) return send(response, 404, { error: "no such route" });
        const body = await handler(parts.slice(1), request, url);
        if (body === undefined) return send(response, 404, { error: "no such route" });
        send(response, 200, body);
      } catch (error) {
        sendError(response, error);
      }
    })();
  };
}

export function witnessServer(service: WitnessService): Server {
  return createServer(witnessListener(service));
}

/** The witness's routes as a request listener, for mounting inside another server. */
export function witnessListener(service: WitnessService): RequestListener {
  return listener({
    "GET ": () => ({ service: "mattering-witness", notice: "Experimental. Not security reviewed.", ...service.info() }),
    "GET policies": ([hash, what]) => {
      if (hash === undefined) return service.listPolicies();
      if (what === undefined || what === "evidence") return service.evidence(hash);
      if (what === "result") return service.result(hash);
      return undefined;
    },
    "POST policies": async (_parts, request) => service.registerPolicy(await readJson(request)),
    "POST submissions": async (_parts, request) => {
      const body = (await readJson(request)) as { submission?: Submission; envelope?: Envelope } | null;
      if (!body?.submission || !body.envelope) throw new MatteringError("MALFORMED", "want { submission, envelope }");
      return service.submit(body.submission, body.envelope);
    },
    "GET log": (_parts, _request, url) => {
      const from = Number(url.searchParams.get("from") ?? 0);
      if (!Number.isSafeInteger(from) || from < 0) throw new MatteringError("MALFORMED", "from: want a non-negative integer");
      return service.log(from);
    },
    "GET checkpoint": () => service.checkpoint(),
    "GET envelopes": ([id]) => (id === undefined ? undefined : service.envelope(id)),
    "GET submitters": ([key]) => (key === undefined ? undefined : service.submitter(key)),
  });
}

/** A cosigner as a service: one route that countersigns closing checkpoints. */
export function cosignerServer(cosigner: Cosigner, onSigned?: () => void): Server {
  return createServer(listener({
    "GET ": () => ({ service: "mattering-cosigner", notice: "Experimental. Not security reviewed.", cosigner: cosigner.publicKey }),
    "POST cosign": async (_parts, request) => {
      const body = (await readJson(request)) as { policyHash?: string; policy?: PolicyTerms; closing?: Checkpoint } | null;
      if (!body?.policyHash || !body.policy || !body.closing) throw new MatteringError("MALFORMED", "want { policyHash, policy, closing }");
      const cosignature = await cosigner.cosign(body.policyHash, body.policy, body.closing);
      onSigned?.();
      return cosignature;
    },
  }));
}

export { readJson, send, sendError };
