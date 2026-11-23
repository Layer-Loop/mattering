/**
 * The witness's HTTP interface as plain functions: method, path and body in,
 * status and JSON out. No server here, so it mounts in Node or anywhere else.
 * Everything served is public; submissions authenticate themselves by signature.
 */
import { MatteringError, type Checkpoint, type Cosigner, type Envelope, type PolicyTerms, type Submission } from "@mattering/core";
import type { WitnessService } from "./service.ts";

export interface Reply {
  status: number;
  body: unknown;
}

/** Largest request body accepted, in bytes. */
export const MAX_BODY = 256 * 1024;

export function errorReply(error: unknown): Reply {
  if (error instanceof MatteringError) {
    const status = (error as { notFound?: boolean }).notFound ? 404 : error.code === "POLICY" ? 409 : error.code === "UNAVAILABLE" ? 503 : 400;
    return { status, body: { error: error.message, code: error.code } };
  }
  console.error(error);
  return { status: 500, body: { error: "internal error" } };
}

const NO_ROUTE: Reply = { status: 404, body: { error: "no such route" } };

/** `path` is like "/policies/<hash>/evidence". `body` is called only for POST. */
export async function handleWitness(service: WitnessService, method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>): Promise<Reply> {
  try {
    const [head = "", a, b] = path.split("/").filter(Boolean);
    const ok = (value: unknown): Reply => ({ status: 200, body: value });
    switch (`${method} ${head}`) {
      case "GET ":
        return ok({ service: "mattering-witness", notice: "Experimental. Not security reviewed.", ...service.info() });
      case "GET policies":
        if (a === undefined) return ok(service.listPolicies());
        if (b === undefined || b === "evidence") return ok(await service.evidence(a));
        if (b === "result") return ok(await service.result(a));
        return NO_ROUTE;
      case "POST policies":
        return ok(await service.registerPolicy(await body()));
      case "POST submissions": {
        const value = (await body()) as { submission?: Submission; envelope?: Envelope } | null;
        if (!value?.submission || !value.envelope) throw new MatteringError("MALFORMED", "want { submission, envelope }");
        return ok(await service.submit(value.submission, value.envelope));
      }
      case "GET log": {
        const from = Number(query.get("from") ?? 0);
        if (!Number.isSafeInteger(from) || from < 0) throw new MatteringError("MALFORMED", "from: want a non-negative integer");
        return ok(service.log(from));
      }
      case "GET checkpoint":
        return ok(await service.checkpoint());
      case "GET envelopes":
        return a === undefined ? NO_ROUTE : ok(await service.envelope(a));
      case "GET submitters":
        return a === undefined ? NO_ROUTE : ok(await service.submitter(a));
      default:
        return NO_ROUTE;
    }
  } catch (error) {
    return errorReply(error);
  }
}

export async function handleCosigner(cosigner: Cosigner, method: string, path: string, body: () => Promise<unknown>, onSigned?: () => void): Promise<Reply> {
  try {
    if (method === "GET" && path === "/") return { status: 200, body: { service: "mattering-cosigner", notice: "Experimental. Not security reviewed.", cosigner: cosigner.publicKey } };
    if (method === "POST" && path === "/cosign") {
      const value = (await body()) as { policyHash?: string; policy?: PolicyTerms; closing?: Checkpoint } | null;
      if (!value?.policyHash || !value.policy || !value.closing) throw new MatteringError("MALFORMED", "want { policyHash, policy, closing }");
      const cosignature = await cosigner.cosign(value.policyHash, value.policy, value.closing);
      onSigned?.();
      return { status: 200, body: cosignature };
    }
    return NO_ROUTE;
  } catch (error) {
    return errorReply(error);
  }
}

/** Parse a JSON request body, with the size cap applied by the caller's reader. */
export function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MatteringError("MALFORMED", "request body is not JSON");
  }
}
