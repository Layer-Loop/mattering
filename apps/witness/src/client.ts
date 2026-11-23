/** A small client for the witness service's HTTP interface. */
import { MatteringError, type Checkpoint, type Cosignature, type Envelope, type MatteringErrorCode, type Receipt, type Submission } from "@mattering/core";
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
  log = (from = 0) => this.call<{ size: number; entries: Submission[] }>(`/log?from=${from}`);
  checkpoint = () => this.call<Checkpoint>("/checkpoint");
  submitter = (key: string) => this.call<{ submitter: string; commitments: Record<string, unknown>[] }>(`/submitters/${key}`);
}

/** Reach cosigners over HTTP, given where each one lives. */
export function httpCosign(urls: Record<string, string>, fetchFn: typeof fetch = fetch): CosignRequest {
  return async (cosigner, policyHash, policy, closing) => {
    const url = urls[cosigner];
    if (!url) return undefined;
    const response = await fetchFn(url.replace(/\/+$/, "") + "/cosign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policyHash, policy, closing }), signal: AbortSignal.timeout(10_000) });
    return response.ok ? ((await response.json()) as Cosignature) : undefined;
  };
}
