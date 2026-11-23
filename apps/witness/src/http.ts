/** Node HTTP servers for the witness service and for a cosigner. */
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { MatteringError, type Cosigner } from "@mattering/core";
import { MAX_BODY, errorReply, handleCosigner, handleWitness, parseBody, type Reply } from "./routes.ts";
import type { WitnessService } from "./service.ts";

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new MatteringError("MALFORMED", "request body too large");
    chunks.push(chunk as Buffer);
  }
  return parseBody(Buffer.concat(chunks).toString("utf8"));
}

export function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  response.end(JSON.stringify(body) + "\n");
}

export function sendError(response: ServerResponse, error: unknown): void {
  const reply = errorReply(error);
  send(response, reply.status, reply.body);
}

function listener(handle: (method: string, url: URL, body: () => Promise<unknown>) => Promise<Reply>): RequestListener {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void handle(request.method ?? "GET", url, () => readJson(request)).then(
      (reply) => send(response, reply.status, reply.body),
      (error: unknown) => sendError(response, error),
    );
  };
}

/** The witness's routes as a request listener, for mounting inside another server. */
export function witnessListener(service: WitnessService): RequestListener {
  return listener((method, url, body) => handleWitness(service, method, url.pathname, url.searchParams, body));
}

export function witnessServer(service: WitnessService): Server {
  return createServer(witnessListener(service));
}

/** A cosigner as a service: one route that countersigns closing checkpoints. */
export function cosignerServer(cosigner: Cosigner, onSigned?: () => void): Server {
  return createServer(listener((method, url, body) => handleCosigner(cosigner, method, url.pathname, body, onSigned)));
}
