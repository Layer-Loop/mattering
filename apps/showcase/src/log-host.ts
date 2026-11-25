/**
 * The one long-lived log every Sealed Room writes into. A room no longer has a
 * witness of its own: it registers its auction with this log, submits its
 * agents' bids to it, and reads evidence back. The log is what public
 * witnesses can be configured with, by its origin and verifier key, so it has
 * to outlive any one room.
 *
 * `LocalLogHost` holds the log in this process. `RemoteLogHost` reaches one
 * over HTTP; `handleLogHost` is the other end of that.
 */
import {
  Cosigner,
  MatteringError,
  closeEntry,
  type AuctionPolicy,
  type BeaconSource,
  type CosignedState,
  type Envelope,
  type LogEntry,
  type MatteringErrorCode,
  type PreparedBid,
  type Receipt,
  type Submission,
} from "@mattering/core";
import { errorReply, handleWitness, type Reply } from "@mattering/witness/routes";
import { WitnessService, type AnyPolicy, type CosignRequest, type EvidenceBundle, type ServiceStore } from "@mattering/witness/service";

/** What a room puts in its policies so that this log will take them. */
export interface LogTerms {
  witness: string;
  origin: string;
  /** The log's size now: a new policy's `logFrom`. */
  size: number;
  cosigners: string[];
  cosignerThreshold: number;
  /** The cosigner run beside the log, if there is one. Not independent. */
  ownCosigner?: string;
}

export interface Forgery {
  shillAmount: number;
  /** What the cosigners were told. The log's key never signs a rewritten log for them, so: nothing. */
  cosignerSaid: string;
  evidence: EvidenceBundle;
}

export interface LogHost {
  terms(): Promise<LogTerms>;
  registerPolicy(policy: AnyPolicy): Promise<string>;
  /** Submit, and return the witness's receipt: where in the log the entry went. */
  submit(submission: Submission, envelope: Envelope): Promise<Receipt>;
  phase(hash: string): Promise<{ state: EvidenceBundle["state"]; cosignatures: number }>;
  /** Submissions under a live policy so far. */
  count(hash: string): Promise<number>;
  submissions(hash: string): Promise<Submission[]>;
  evidence(hash: string): Promise<EvidenceBundle>;
  /** What a dishonest operator could produce for a released auction: the log rewritten with `shill` before the close. */
  forge(hash: string, shill: PreparedBid): Promise<Forgery>;
  /** Do whatever the log has due. A remote log does its own. */
  tick(): Promise<void>;
  /** The witness's public HTTP interface, as served for this log. */
  api(method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>): Promise<Reply>;
}

/** A cosigner run beside the log by the same operator. Not independent: for showing the protocol until public witnesses cosign. */
export interface OwnCosigner {
  name: string;
  secretKey: string;
  state: Record<string, CosignedState>;
  persist: (state: Record<string, CosignedState>) => Promise<void>;
  /** UNIX seconds by the cosigner's own clock. */
  clock: () => number;
}

export interface LocalLogOptions {
  store: ServiceStore;
  source: BeaconSource;
  origin?: string | undefined;
  secretKey?: string | undefined;
  /** Public witnesses that cosign this log: verifier key to add-checkpoint URL prefix. */
  witnesses?: Record<string, string>;
  /** Reach the public witnesses. Required when there are any. */
  reachWitness?: CosignRequest;
  ownCosigner?: OwnCosigner | undefined;
  /** Least milliseconds between two requests to one cosigner. Default: the service's, 3,000 (one drand quicknet round). */
  minCosignIntervalMs?: number;
}

/**
 * Policies need a majority of their cosigners (see `assertTerms`), and the
 * room's policies name every cosigner this log has.
 */
export function majority(count: number): number {
  return count === 0 ? 0 : Math.floor(count / 2) + 1;
}

export class LocalLogHost implements LogHost {
  private constructor(
    readonly service: WitnessService,
    private readonly cosigners: string[],
    private readonly own: string | undefined,
  ) {}

  static async open(options: LocalLogOptions): Promise<LocalLogHost> {
    const own = options.ownCosigner;
    let cosigner: Cosigner | undefined;
    if (own) {
      const state = { ...own.state };
      cosigner = new Cosigner({
        name: own.name,
        logs: [],
        clock: own.clock,
        secretKey: own.secretKey,
        state,
        // Remember what was cosigned before handing it over, so a restart cannot be used to get a fork cosigned.
        persist: async (origin, latest) => {
          state[origin] = latest;
          await own.persist(state);
        },
      });
    }
    const witnesses = options.witnesses ?? {};
    const service = await WitnessService.open({
      store: options.store,
      source: options.source,
      origin: options.origin,
      secretKey: options.secretKey,
      ...(options.minCosignIntervalMs !== undefined ? { minCosignIntervalMs: options.minCosignIntervalMs } : {}),
      cosign: async (vkey, body) => {
        if (cosigner && vkey === cosigner.vkey) {
          const reply = await cosigner.addCheckpoint(body);
          return { status: reply.status, body: reply.body };
        }
        return vkey in witnesses ? options.reachWitness?.(vkey, body) : undefined;
      },
    });
    cosigner?.addLog(service.vkey);
    return new LocalLogHost(service, [...(cosigner ? [cosigner.vkey] : []), ...Object.keys(witnesses)], cosigner?.vkey);
  }

  async terms(): Promise<LogTerms> {
    const terms: LogTerms = { witness: this.service.publicKey, origin: this.service.origin, size: this.service.size, cosigners: this.cosigners, cosignerThreshold: majority(this.cosigners.length) };
    return this.own ? { ...terms, ownCosigner: this.own } : terms;
  }

  async registerPolicy(policy: AnyPolicy): Promise<string> {
    return (await this.service.registerPolicy(policy)).policyHash;
  }

  submit(submission: Submission, envelope: Envelope): Promise<Receipt> {
    return this.service.submit(submission, envelope);
  }

  phase(hash: string): Promise<{ state: EvidenceBundle["state"]; cosignatures: number }> {
    return this.service.phase(hash);
  }

  async count(hash: string): Promise<number> {
    return this.service.count(hash);
  }

  submissions(hash: string): Promise<Submission[]> {
    return this.service.submissions(hash);
  }

  evidence(hash: string): Promise<EvidenceBundle> {
    return this.service.evidence(hash);
  }

  /**
   * Rewrite the auction's stretch of the log with a winning bid of its own just
   * before the close, and sign a new closing checkpoint with the witness's real
   * key. The log's C2SP checkpoints are never signed for the rewrite, so no
   * cosigner, ours or public, is shown it: a log that did that would be caught
   * signing two versions of itself. The cosignatures already given cover the
   * original, which is what makes the rewrite fail.
   */
  async forge(hash: string, shill: PreparedBid): Promise<Forgery> {
    const bundle = await this.service.evidence(hash);
    if (bundle.state !== "released") throw new MatteringError("POLICY", "the bids have not been released yet");
    const policy = bundle.policy as AuctionPolicy;
    const forger = this.service.copyUpTo(policy.logFrom);
    const entries: LogEntry[] = [];
    // The same log up to the close, then a bid of its own, then the close.
    for (const entry of bundle.entries!.slice(0, -1)) {
      if (entry.format === "mattering.close/1") forger.close(entry.policyHash, policy.beacon, entry.observed);
      else forger.submit(entry);
      entries.push(entry);
    }
    forger.submit(shill.submission);
    entries.push(shill.submission);
    const closing = forger.close(hash, policy.beacon, bundle.closing!.observed);
    entries.push(closeEntry(hash, bundle.closing!.observed));
    return {
      shillAmount: policy.maxBid,
      cosignerSaid: "not asked: the log never shows a cosigner a version of itself it has rewritten",
      evidence: { ...bundle, entries, closing, envelopes: { ...bundle.envelopes, [shill.submission.envelopeId]: shill.envelope } },
    };
  }

  tick(): Promise<void> {
    return this.service.tick();
  }

  /** True while some policy is open or waiting for its release: the log needs ticking. */
  get busy(): boolean {
    return this.service.listPolicies().length > 0;
  }

  api(method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>): Promise<Reply> {
    return handleWitness(this.service, method, path, query, body);
  }
}

/**
 * The log host's HTTP interface for rooms: `/host/…` for what rooms need, and
 * everything else is the witness's public interface. Mount it only where rooms
 * can reach it; the public should see the witness routes alone.
 */
export async function handleLogHost(host: LogHost, method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>): Promise<Reply> {
  if (!path.startsWith("/host/")) return host.api(method, path, query, body);
  try {
    const ok = (value: unknown): Reply => ({ status: 200, body: value });
    const [, , a, hash, what] = path.split("/");
    if (method === "GET" && a === "terms") return ok(await host.terms());
    if (a === "policies" && hash !== undefined) {
      if (method === "GET" && what === "phase") return ok(await host.phase(hash));
      if (method === "GET" && what === "count") return ok({ count: await host.count(hash) });
      if (method === "GET" && what === "submissions") return ok(await host.submissions(hash));
      if (method === "POST" && what === "forge") return ok(await host.forge(hash, (await body()) as PreparedBid));
    }
    return { status: 404, body: { error: "no such route" } };
  } catch (error) {
    return errorReply(error);
  }
}

/** A log host reached over HTTP, at whatever `fetchFn` sends requests to. */
export class RemoteLogHost implements LogHost {
  constructor(private readonly fetchFn: (path: string, init?: RequestInit) => Promise<Response>) {}

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetchFn(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json()) as { error?: string; code?: string };
    if (!response.ok) throw new MatteringError((json.code as MatteringErrorCode | undefined) ?? "UNAVAILABLE", json.error ?? `log: HTTP ${response.status}`);
    return json as T;
  }

  terms = (): Promise<LogTerms> => this.call("/host/terms");
  registerPolicy = async (policy: AnyPolicy): Promise<string> => (await this.call<{ policyHash: string }>("/policies", policy)).policyHash;
  submit = (submission: Submission, envelope: Envelope): Promise<Receipt> => this.call("/submissions", { submission, envelope });
  phase = (hash: string): Promise<{ state: EvidenceBundle["state"]; cosignatures: number }> => this.call(`/host/policies/${hash}/phase`);
  count = async (hash: string): Promise<number> => (await this.call<{ count: number }>(`/host/policies/${hash}/count`)).count;
  submissions = (hash: string): Promise<Submission[]> => this.call(`/host/policies/${hash}/submissions`);
  evidence = (hash: string): Promise<EvidenceBundle> => this.call(`/policies/${hash}/evidence`);
  forge = (hash: string, shill: PreparedBid): Promise<Forgery> => this.call(`/host/policies/${hash}/forge`, shill);
  tick = async (): Promise<void> => {};

  async api(method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>): Promise<Reply> {
    const search = query.toString();
    const response = await this.fetchFn(path + (search ? `?${search}` : ""), method === "POST" ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(await body()) } : { method });
    return { status: response.status, body: await response.json() };
  }
}
