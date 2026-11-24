/** A small client for the witness service's HTTP interface. */
import { MatteringError, type Checkpoint, type Envelope, type LogEntry, type MatteringErrorCode, type Receipt, type Submission } from "@mattering/core";
import type { AnyPolicy, CosignRequest, EvidenceBundle } from "./service.ts";

export class WitnessClient {
  constructor(private readonly baseUrl: string, private readonly fetchFn: typeof fetch = fetch) {}

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetchFn(this.baseUrl.replace(/\/+$/, "") + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json()) as { error?: string; code?: MatteringErrorCode };
    if (!response.ok) throw Object.assign(new MatteringError(json.code ?? "UNAVAILABLE", json.error ?? `HTTP ${response.status}`), { status: response.status });
    return json as T;
  }

  info = () => this.call<{ witness: string; size: number }>("/");
  registerPolicy = (policy: AnyPolicy) => this.call<{ policyHash: string }>("/policies", policy);
  submit = (submission: Submission, envelope: Envelope) => this.call<Receipt>("/submissions", { submission, envelope });
  evidence = (policyHash: string) => this.call<EvidenceBundle>(`/policies/${policyHash}/evidence`);
  result = (policyHash: string) => this.call<{ state: string; kind: string; result?: unknown }>(`/policies/${policyHash}/result`);
  log = (from = 0) => this.call<{ size: number; entries: LogEntry[] }>(`/log?from=${from}`);
  checkpoint = () => this.call<Checkpoint>("/checkpoint");
  submitter = (key: string) => this.call<{ submitter: string; commitments: Record<string, unknown>[] }>(`/submitters/${key}`);
}

/**
 * Reach cosigners over HTTP, given each one's verifier key and submission
 * prefix: `<prefix>/add-checkpoint` as in C2SP tlog-witness. Works the same for
 * a Mattering cosigner and for a public witness.
 */
export function httpCosign(urls: Record<string, string>, fetchFn: typeof fetch = fetch): CosignRequest {
  return async (cosigner, body) => {
    const url = urls[cosigner];
    if (!url) return undefined;
    const response = await fetchFn(url.replace(/\/+$/, "") + "/add-checkpoint", { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.text() };
  };
}
