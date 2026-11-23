/**
 * The witness and registry as a service: policies, submissions, the log,
 * closing on the beacon's clock, cosignatures, and published evidence.
 *
 * This file has no HTTP, no file system and no timers in it, so it runs the
 * same on a laptop and in a hosted runtime. State goes through a `ServiceStore`.
 */
import {
  MatteringError,
  POLICY_FORMAT,
  STATEMENT_POLICY_FORMAT,
  Witness,
  assertEnvelope,
  deadlineRound,
  envelopeId,
  policyHash,
  sameBeacon,
  statementPolicyHash,
  verifyAuction,
  verifyCosignature,
  verifySealedStatement,
  verifySealedSubmission,
  verifyStatements,
  verifySubmissionSignature,
  type AuctionPolicy,
  type AuctionResult,
  type BeaconSource,
  type Checkpoint,
  type Cosignature,
  type Envelope,
  type PolicyTerms,
  type Receipt,
  type Release,
  type StatementPolicy,
  type StatementsResult,
  type Submission,
} from "@mattering/core";

export type AnyPolicy = AuctionPolicy | StatementPolicy;
export type PolicyKind = "auction" | "statements";

/** Ask one cosigner to countersign. Returns undefined if it cannot be reached or refuses. */
export type CosignRequest = (cosigner: string, policyHash: string, policy: AnyPolicy, closing: Checkpoint) => Promise<Cosignature | undefined>;

export interface StoredClosing {
  closing: Checkpoint;
  cosignatures: Cosignature[];
}

export interface StoredState {
  /** The witness's signing key, if one has been saved. */
  secretKey?: string;
  /** The log, in order. */
  entries: Submission[];
  policies: AnyPolicy[];
  closings: Record<string, StoredClosing>;
}

/** Where a witness keeps its state. Every write must be durable before it resolves. */
export interface ServiceStore {
  load(): Promise<StoredState>;
  saveKey(secretKey: string): Promise<void>;
  appendEntry(index: number, submission: Submission): Promise<void>;
  savePolicy(hash: string, policy: AnyPolicy): Promise<void>;
  saveEnvelope(id: string, envelope: Envelope): Promise<void>;
  loadEnvelope(id: string): Promise<Envelope | undefined>;
  saveClosing(hash: string, value: StoredClosing): Promise<void>;
}

/** A store that forgets everything when the process ends. For tests and demonstrations. */
export function memoryStore(): ServiceStore {
  const state: StoredState = { entries: [], policies: [], closings: {} };
  const envelopes = new Map<string, Envelope>();
  return {
    load: async () => structuredClone(state),
    saveKey: async (secretKey) => void (state.secretKey = secretKey),
    appendEntry: async (index, submission) => void (state.entries[index] = submission),
    savePolicy: async (_hash, policy) => void state.policies.push(policy),
    saveEnvelope: async (id, envelope) => void envelopes.set(id, envelope),
    loadEnvelope: async (id) => envelopes.get(id),
    saveClosing: async (hash, value) => void (state.closings[hash] = structuredClone(value)),
  };
}

export interface ServiceOptions {
  store: ServiceStore;
  /** This witness's own view of the beacon. */
  source: BeaconSource;
  cosign?: CosignRequest;
}

interface PolicyRecord {
  hash: string;
  kind: PolicyKind;
  policy: AnyPolicy;
  closing?: Checkpoint;
  cosignatures: Cosignature[];
}

export interface EvidenceBundle {
  policy: AnyPolicy;
  policyHash: string;
  /** "open": accepting submissions. "closed": sealed, waiting for release. "released": can be opened. */
  state: "open" | "closed" | "released";
  entries?: Submission[];
  closing?: Checkpoint;
  cosignatures?: Cosignature[];
  envelopes?: Record<string, Envelope>;
  release?: Release;
}

function describe(policy: unknown): { hash: string; kind: PolicyKind } {
  const format = (policy as { format?: unknown } | null)?.format;
  if (format === POLICY_FORMAT) return { hash: policyHash(policy as AuctionPolicy), kind: "auction" };
  if (format === STATEMENT_POLICY_FORMAT) return { hash: statementPolicyHash(policy as StatementPolicy), kind: "statements" };
  throw new MatteringError("MALFORMED", "unknown policy format");
}

function notFound(what: string): MatteringError {
  return Object.assign(new MatteringError("MALFORMED", `${what} not found`), { notFound: true });
}

const HEX32 = /^[0-9a-f]{64}$/;

export class WitnessService {
  private readonly results = new Map<string, AuctionResult | StatementsResult>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: ServiceOptions,
    private readonly witness: Witness,
    private readonly policies: Map<string, PolicyRecord>,
  ) {}

  /** Load a witness from its store, creating its signing key on first use. */
  static async open(options: ServiceOptions): Promise<WitnessService> {
    const stored = await options.store.load();
    const policies = new Map<string, PolicyRecord>();
    const closings: [string, Checkpoint][] = [];
    for (const policy of stored.policies) {
      const { hash, kind } = describe(policy);
      const saved = stored.closings[hash];
      const record: PolicyRecord = { hash, kind, policy, cosignatures: saved?.cosignatures ?? [] };
      if (saved) {
        record.closing = saved.closing;
        closings.push([hash, saved.closing]);
      }
      policies.set(hash, record);
    }
    const witness = new Witness(stored.secretKey, { entries: stored.entries, closings });
    if (!stored.secretKey) await options.store.saveKey(witness.keys.secretKey);
    return new WitnessService(options, witness, policies);
  }

  get publicKey(): string {
    return this.witness.publicKey;
  }

  /** Run state-changing work one at a time, so the log has one order. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private record(hash: string): PolicyRecord {
    const record = HEX32.test(hash) ? this.policies.get(hash) : undefined;
    if (!record) throw notFound("policy");
    return record;
  }

  info(): { witness: string; beacon: BeaconSource["beacon"]; size: number; policies: number } {
    return { witness: this.publicKey, beacon: this.options.source.beacon, size: this.witness.size, policies: this.policies.size };
  }

  listPolicies(): { policyHash: string; kind: PolicyKind; closeRound: number; releaseRound: number; closed: boolean }[] {
    return [...this.policies.values()].map((r) => ({ policyHash: r.hash, kind: r.kind, closeRound: r.policy.closeRound, releaseRound: r.policy.releaseRound, closed: r.closing !== undefined }));
  }

  registerPolicy(policy: unknown): Promise<{ policyHash: string }> {
    return this.exclusive(async () => {
      const { hash, kind } = describe(policy);
      const typed = policy as AnyPolicy;
      if (this.policies.has(hash)) return { policyHash: hash };
      if (typed.witness !== this.publicKey) throw new MatteringError("POLICY", "the policy names a different witness");
      if (!sameBeacon(typed.beacon, this.options.source.beacon)) throw new MatteringError("POLICY", "this witness does not watch the policy's beacon");
      if (typed.closeRound <= (await deadlineRound(this.options.source)).round) throw new MatteringError("POLICY", "the policy's close round has already passed");
      await this.options.store.savePolicy(hash, typed);
      this.policies.set(hash, { hash, kind, policy: typed, cosignatures: [] });
      return { policyHash: hash };
    });
  }

  submit(submission: Submission, envelope: Envelope): Promise<Receipt> {
    return this.exclusive(async () => {
      if (!verifySubmissionSignature(submission)) throw new MatteringError("MALFORMED", "submission is malformed or its signature is invalid");
      const record = this.record(submission.policyHash);
      assertEnvelope(envelope);
      const verifier = { acceptedBeacons: [this.options.source.beacon] };
      const checks =
        record.kind === "auction"
          ? verifySealedSubmission(record.policy as AuctionPolicy, submission, envelope, verifier)
          : verifySealedStatement(record.policy as StatementPolicy, submission, envelope, verifier);
      const failed = checks.find((c) => !c.ok);
      if (failed) throw new MatteringError("MALFORMED", `submission rejected: ${failed.name}${failed.detail ? ` (${failed.detail})` : ""}`);
      if ((record.kind === "auction") !== (submission.commitment !== undefined)) {
        throw new MatteringError("MALFORMED", record.kind === "auction" ? "an auction submission needs a commitment" : "a statement submission carries no commitment");
      }
      // The deadline: the close round has been emitted as far as this witness
      // has seen, or is due by this witness's clock and the beacon's schedule,
      // whichever comes first. Nothing the submitter says about time is consulted.
      const now = await this.closeDue();
      if (record.closing || record.policy.closeRound <= now) {
        throw new MatteringError("POLICY", "late: this policy closed at its close round");
      }
      // Durable first, then acknowledged: a receipt is never given for an entry that could be lost.
      await this.options.store.saveEnvelope(envelopeId(envelope), envelope);
      await this.options.store.appendEntry(this.witness.size, submission);
      return this.witness.submit(submission);
    });
  }

  /** Close every policy whose close round has been emitted, and collect cosignatures. Call regularly. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      await this.closeDue();
    });
  }

  /** Returns the round deadlines are judged against. */
  private async closeDue(): Promise<number> {
    const source = this.options.source;
    const { latest, round: now } = await deadlineRound(source);
    for (const record of this.policies.values()) {
      const terms: PolicyTerms = record.policy;
      if (!record.closing && terms.closeRound <= now) {
        const closeRelease = await source.get(terms.closeRound);
        // Without the close round's signature the closing checkpoint cannot be
        // made yet. submit() already refuses, so nothing gets in meanwhile.
        if (!closeRelease) continue;
        record.closing = this.witness.close(record.hash, source.beacon, closeRelease);
        await this.saveClosing(record);
      }
      if (record.closing && now < terms.releaseRound && latest.round >= terms.closeRound && this.options.cosign) {
        const have = new Set(record.cosignatures.map((c) => c.cosigner));
        for (const cosigner of terms.cosigners) {
          if (have.has(cosigner)) continue;
          const cosignature = await this.options.cosign(cosigner, record.hash, record.policy, record.closing).catch(() => undefined);
          if (cosignature && verifyCosignature(cosignature, record.closing, terms)) {
            record.cosignatures.push(cosignature);
            await this.saveClosing(record);
          }
        }
      }
    }
    return now;
  }

  private saveClosing(record: PolicyRecord): Promise<void> {
    return this.options.store.saveClosing(record.hash, { closing: record.closing!, cosignatures: record.cosignatures });
  }

  log(from = 0): { size: number; from: number; entries: Submission[] } {
    const entries = this.witness.entries();
    return { size: entries.length, from, entries: entries.slice(from) };
  }

  /** How many log entries name this policy. */
  count(hash: string): number {
    return this.witness.entries().filter((e) => e.policyHash === hash).length;
  }

  async checkpoint(): Promise<Checkpoint> {
    return this.witness.checkpoint(this.options.source.beacon, await this.options.source.latest());
  }

  async envelope(id: string): Promise<Envelope> {
    const envelope = HEX32.test(id) ? await this.options.store.loadEnvelope(id) : undefined;
    if (!envelope) throw notFound("envelope");
    return envelope;
  }

  /** The policy's state without loading its envelopes. */
  async phase(hash: string): Promise<{ state: EvidenceBundle["state"]; cosignatures: number }> {
    const record = this.record(hash);
    if (!record.closing) return { state: "open", cosignatures: 0 };
    const release = await this.options.source.get(record.policy.releaseRound);
    return { state: release ? "released" : "closed", cosignatures: record.cosignatures.length };
  }

  /** Everything a verifier needs for one policy, as far as it exists yet. */
  async evidence(hash: string): Promise<EvidenceBundle> {
    const record = this.record(hash);
    const base = { policy: record.policy, policyHash: hash };
    if (!record.closing) return { ...base, state: "open" };
    const entries = this.witness.entries().slice(0, record.closing.size);
    const envelopes: Record<string, Envelope> = {};
    for (const entry of entries) {
      if (entry.policyHash === hash) envelopes[entry.envelopeId] = await this.envelope(entry.envelopeId);
    }
    const closed = { ...base, entries, closing: record.closing, cosignatures: record.cosignatures, envelopes };
    const release = await this.options.source.get(record.policy.releaseRound);
    return release ? { ...closed, state: "released", release } : { ...closed, state: "closed" };
  }

  /**
   * The outcome as this service computes it. A convenience: anyone can and
   * should recompute it from `evidence` with the same library.
   */
  async result(hash: string): Promise<{ state: EvidenceBundle["state"]; kind: PolicyKind; result?: AuctionResult | StatementsResult }> {
    const record = this.record(hash);
    const bundle = await this.evidence(hash);
    if (bundle.state !== "released") return { state: bundle.state, kind: record.kind };
    let result = this.results.get(hash);
    if (!result) {
      const verifier = { acceptedBeacons: [this.options.source.beacon] };
      const inputs = { entries: bundle.entries!, closing: bundle.closing!, cosignatures: bundle.cosignatures!, envelopes: bundle.envelopes!, release: bundle.release! };
      result =
        record.kind === "auction"
          ? await verifyAuction({ policy: record.policy as AuctionPolicy, ...inputs }, verifier)
          : await verifyStatements({ policy: record.policy as StatementPolicy, ...inputs }, verifier);
      this.results.set(hash, result);
    }
    return { state: "released", kind: record.kind, result };
  }

  /** The registry view: everything one key has committed to, and what has opened. */
  async submitter(key: string): Promise<{ submitter: string; commitments: Record<string, unknown>[] }> {
    if (!HEX32.test(key)) throw notFound("submitter");
    const commitments: Record<string, unknown>[] = [];
    const entries = this.witness.entries();
    for (const [index, entry] of entries.entries()) {
      if (entry.submitter !== key) continue;
      const record = this.policies.get(entry.policyHash)!;
      const item: Record<string, unknown> = { index, policyHash: entry.policyHash, kind: record.kind, envelopeId: entry.envelopeId, releaseRound: record.policy.releaseRound };
      if (!record.closing) item.state = "sealed, policy open";
      else if (index >= record.closing.size) item.state = "late";
      else {
        const { state, result } = await this.result(entry.policyHash);
        if (state !== "released" || !result) item.state = "sealed";
        else if (!result.ok) item.state = "evidence invalid";
        else {
          const outcomes: { index: number }[] = "bids" in result ? result.bids : result.statements;
          const { index: _i, ...outcome } = (outcomes.find((o) => o.index === index) ?? { index }) as { index: number } & Record<string, unknown>;
          delete outcome.submitter;
          delete outcome.author;
          delete outcome.envelopeId;
          Object.assign(item, { state: "opened" }, outcome);
        }
      }
      commitments.push(item);
    }
    return { submitter: key, commitments };
  }
}
