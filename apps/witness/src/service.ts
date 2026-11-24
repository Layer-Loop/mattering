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
  countCosignatures,
  parseVkey,
  verifyAuction,
  verifySealedStatement,
  verifySealedSubmission,
  verifyStatements,
  verifySubmissionSignature,
  type AuctionPolicy,
  type AuctionResult,
  type BeaconSource,
  type Checkpoint,
  type Envelope,
  type PolicyTerms,
  type Receipt,
  type Release,
  type StatementPolicy,
  type StatementsResult,
  type LogEntry,
  type Submission,
  type WitnessedCheckpoint,
  isSubmission,
} from "@mattering/core";

export type AnyPolicy = AuctionPolicy | StatementPolicy;
export type PolicyKind = "auction" | "statements";

/**
 * Send one C2SP tlog-witness add-checkpoint request to the cosigner with this
 * verifier key. Resolves to its HTTP status and body, or undefined if it
 * cannot be reached.
 */
export type CosignRequest = (cosigner: string, body: string) => Promise<{ status: number; body: string } | undefined>;

export interface StoredClosing {
  closing: Checkpoint;
  witnessed?: WitnessedCheckpoint;
}

export interface StoredState {
  /** The witness's signing key, if one has been saved. */
  secretKey?: string;
  /** The log, in order: submissions and close entries. */
  entries: LogEntry[];
  policies: AnyPolicy[];
  closings: Record<string, StoredClosing>;
}

/** Where a witness keeps its state. Every write must be durable before it resolves. */
export interface ServiceStore {
  load(): Promise<StoredState>;
  saveKey(secretKey: string): Promise<void>;
  appendEntry(index: number, entry: LogEntry): Promise<void>;
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
    appendEntry: async (index, entry) => void (state.entries[index] = entry),
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
  /** The log's C2SP origin. Defaults to one derived from the witness's key. Fix it before the first policy. */
  origin?: string | undefined;
  cosign?: CosignRequest;
}

interface PolicyRecord {
  hash: string;
  kind: PolicyKind;
  policy: AnyPolicy;
  closing?: Checkpoint;
  witnessed?: WitnessedCheckpoint | undefined;
}

export interface EvidenceBundle {
  policy: AnyPolicy;
  policyHash: string;
  /** "open": accepting submissions. "closed": sealed, waiting for release. "released": can be opened. */
  state: "open" | "closed" | "released";
  entries?: LogEntry[];
  closing?: Checkpoint;
  witnessed?: WitnessedCheckpoint | undefined;
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
  /** The latest size each cosigner has cosigned for this log, as far as this process knows. */
  private readonly cosignedSize = new Map<string, number>();
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
      const record: PolicyRecord = { hash, kind, policy };
      if (saved) {
        record.closing = saved.closing;
        record.witnessed = saved.witnessed;
        closings.push([hash, saved.closing]);
      }
      policies.set(hash, record);
    }
    const witness = new Witness(stored.secretKey, { entries: stored.entries, closings }, options.origin);
    if (!stored.secretKey) await options.store.saveKey(witness.keys.secretKey);
    return new WitnessService(options, witness, policies);
  }

  get publicKey(): string {
    return this.witness.publicKey;
  }

  /** The log's origin and verifier key: what a cosigner is configured with. */
  get origin(): string {
    return this.witness.origin;
  }

  get vkey(): string {
    return this.witness.vkey;
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

  info(): { witness: string; origin: string; vkey: string; beacon: BeaconSource["beacon"]; size: number; policies: number } {
    return { witness: this.publicKey, origin: this.origin, vkey: this.vkey, beacon: this.options.source.beacon, size: this.witness.size, policies: this.policies.size };
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
      if (typed.origin !== this.origin) throw new MatteringError("POLICY", "the policy names a different log");
      if (!sameBeacon(typed.beacon, this.options.source.beacon)) throw new MatteringError("POLICY", "this witness does not watch the policy's beacon");
      if (typed.closeRound <= (await deadlineRound(this.options.source)).round) throw new MatteringError("POLICY", "the policy's close round has already passed");
      await this.options.store.savePolicy(hash, typed);
      this.policies.set(hash, { hash, kind, policy: typed });
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
        // The close entry is part of the log, so it is stored like any entry.
        await this.options.store.appendEntry(record.closing.size - 1, this.witness.entries()[record.closing.size - 1]!);
        await this.saveClosing(record);
      }
      const have = record.closing ? countCosignatures(terms, record.closing, record.witnessed).cosigners.length : 0;
      if (record.closing && now < terms.releaseRound && latest.round >= terms.closeRound && this.options.cosign && have < terms.cosigners.length) {
        await this.witnessClosing(record, have);
      }
    }
    return now;
  }

  /**
   * Show the log as it stands now to each of the policy's cosigners, and keep
   * the cosigned checkpoint if more of them vouched for it than before. The log
   * now extends the closing checkpoint, so one checkpoint serves every policy
   * closed so far.
   */
  private async witnessClosing(record: PolicyRecord, have: number): Promise<void> {
    const size = this.witness.size;
    const checkpoint = this.witness.logCheckpoint(size);
    let lines = "";
    for (const cosigner of record.policy.cosigners) lines += (await this.requestCosignature(cosigner, checkpoint, size)) ?? "";
    const witnessed = { checkpoint: checkpoint + lines, proof: this.witness.consistency(record.closing!.size, size) };
    if (countCosignatures(record.policy, record.closing!, witnessed).cosigners.length > have) {
      record.witnessed = witnessed;
      await this.saveClosing(record);
    }
  }

  /** One cosigner's signature lines for `checkpoint`, or undefined. Follows a 409 once, as the protocol intends. */
  private async requestCosignature(cosigner: string, checkpoint: string, size: number): Promise<string | undefined> {
    const name = parseVkey(cosigner).name;
    for (let attempt = 0; attempt < 2; attempt++) {
      const old = this.cosignedSize.get(cosigner) ?? 0;
      if (old > size) return undefined;
      const body = `old ${old}\n` + this.witness.consistency(old, size).map((p) => p + "\n").join("") + "\n" + checkpoint;
      const reply = await this.options.cosign!(cosigner, body).catch(() => undefined);
      if (reply?.status === 409 && /^(0|[1-9][0-9]*)\n$/.test(reply.body)) {
        this.cosignedSize.set(cosigner, Number(reply.body.trim()));
        continue;
      }
      if (reply?.status !== 200) return undefined;
      this.cosignedSize.set(cosigner, size);
      // Keep only this cosigner's lines; a response may carry several signatures.
      return reply.body.split("\n").filter((line) => line.startsWith(`\u2014 ${name} `)).map((line) => line + "\n").join("") || undefined;
    }
    return undefined;
  }

  private saveClosing(record: PolicyRecord): Promise<void> {
    return this.options.store.saveClosing(record.hash, record.witnessed ? { closing: record.closing!, witnessed: record.witnessed } : { closing: record.closing! });
  }

  log(from = 0): { size: number; from: number; entries: LogEntry[] } {
    const entries = this.witness.entries();
    return { size: entries.length, from, entries: entries.slice(from) };
  }

  /** How many log entries name this policy. */
  count(hash: string): number {
    return this.witness.entries().filter((e) => isSubmission(e) && e.policyHash === hash).length;
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
    const cosignatures = countCosignatures(record.policy, record.closing, record.witnessed).cosigners.length;
    return { state: release ? "released" : "closed", cosignatures };
  }

  /** Everything a verifier needs for one policy, as far as it exists yet. */
  async evidence(hash: string): Promise<EvidenceBundle> {
    const record = this.record(hash);
    const base = { policy: record.policy, policyHash: hash };
    if (!record.closing) return { ...base, state: "open" };
    const entries = this.witness.entries().slice(0, record.closing.size);
    const envelopes: Record<string, Envelope> = {};
    for (const entry of entries) {
      if (isSubmission(entry) && entry.policyHash === hash) envelopes[entry.envelopeId] = await this.envelope(entry.envelopeId);
    }
    const closed = { ...base, entries, closing: record.closing, ...(record.witnessed ? { witnessed: record.witnessed } : {}), envelopes };
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
      const inputs = { entries: bundle.entries!, closing: bundle.closing!, witnessed: bundle.witnessed, envelopes: bundle.envelopes!, release: bundle.release! };
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
      if (!isSubmission(entry) || entry.submitter !== key) continue;
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
