/**
 * The witness and registry as a service: policies, submissions, the log,
 * closing on the beacon's clock, cosignatures, and published evidence.
 *
 * This file has no HTTP in it. State lives in a directory of plain files:
 *
 *   witness-key.json         the witness's signing key (keep private)
 *   log.jsonl                one submission per line, append-only
 *   policies/<hash>.json     registered policies
 *   envelopes/<id>.json      sealed envelopes, kept so they can be opened later
 *   closings/<hash>.json     closing checkpoint and cosignatures per policy
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MatteringError,
  POLICY_FORMAT,
  STATEMENT_POLICY_FORMAT,
  Witness,
  assertEnvelope,
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

export interface ServiceOptions {
  dataDir: string;
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
  private readonly witness: Witness;
  private readonly policies = new Map<string, PolicyRecord>();
  private readonly results = new Map<string, AuctionResult | StatementsResult>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ServiceOptions) {
    const dir = options.dataDir;
    for (const sub of ["", "policies", "envelopes", "closings"]) mkdirSync(join(dir, sub), { recursive: true });

    const keyFile = join(dir, "witness-key.json");
    let secretKey: string | undefined;
    if (existsSync(keyFile)) secretKey = (JSON.parse(readFileSync(keyFile, "utf8")) as { secretKey: string }).secretKey;

    const entries: Submission[] = existsSync(join(dir, "log.jsonl"))
      ? readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Submission)
      : [];
    const closings: [string, Checkpoint][] = [];
    for (const file of readdirSync(join(dir, "policies"))) {
      const policy = JSON.parse(readFileSync(join(dir, "policies", file), "utf8")) as AnyPolicy;
      const { hash, kind } = describe(policy);
      const record: PolicyRecord = { hash, kind, policy, cosignatures: [] };
      const closingFile = join(dir, "closings", `${hash}.json`);
      if (existsSync(closingFile)) {
        const saved = JSON.parse(readFileSync(closingFile, "utf8")) as { closing: Checkpoint; cosignatures: Cosignature[] };
        record.closing = saved.closing;
        record.cosignatures = saved.cosignatures;
        closings.push([hash, saved.closing]);
      }
      this.policies.set(hash, record);
    }
    this.witness = new Witness(secretKey, { entries, closings });
    if (!secretKey) {
      writeFileSync(keyFile, JSON.stringify({ secretKey: this.witness.keys.secretKey }) + "\n", { mode: 0o600 });
      chmodSync(keyFile, 0o600);
    }
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
      if (typed.closeRound <= (await this.options.source.latest()).round) throw new MatteringError("POLICY", "the policy's close round has already passed");
      writeFileSync(join(this.options.dataDir, "policies", `${hash}.json`), JSON.stringify(typed, null, 2) + "\n");
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
      // The deadline, on the beacon's clock as this witness sees it. Nothing the
      // submitter says about time is consulted.
      const latest = await this.closeDue();
      if (record.closing || record.policy.closeRound <= latest.round) {
        throw new MatteringError("POLICY", "late: this policy closed at its close round");
      }
      const receipt = this.witness.submit(submission);
      appendFileSync(join(this.options.dataDir, "log.jsonl"), JSON.stringify(submission) + "\n");
      writeFileSync(join(this.options.dataDir, "envelopes", `${envelopeId(envelope)}.json`), JSON.stringify(envelope) + "\n");
      return receipt;
    });
  }

  /** Close every policy whose close round has been emitted, and collect cosignatures. Call regularly. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      await this.closeDue();
    });
  }

  private async closeDue(): Promise<Release> {
    const source = this.options.source;
    const latest = await source.latest();
    for (const record of this.policies.values()) {
      const terms: PolicyTerms = record.policy;
      if (!record.closing && terms.closeRound <= latest.round) {
        const closeRelease = await source.get(terms.closeRound);
        // Without the close round's signature the closing checkpoint cannot be
        // made yet. submit() refuses on `latest` alone, so nothing gets in meanwhile.
        if (!closeRelease) continue;
        record.closing = this.witness.close(record.hash, source.beacon, closeRelease);
        this.saveClosing(record);
      }
      if (record.closing && latest.round < terms.releaseRound && this.options.cosign) {
        const have = new Set(record.cosignatures.map((c) => c.cosigner));
        for (const cosigner of terms.cosigners) {
          if (have.has(cosigner)) continue;
          const cosignature = await this.options.cosign(cosigner, record.hash, record.policy, record.closing).catch(() => undefined);
          if (cosignature && verifyCosignature(cosignature, record.closing, terms)) {
            record.cosignatures.push(cosignature);
            this.saveClosing(record);
          }
        }
      }
    }
    return latest;
  }

  private saveClosing(record: PolicyRecord): void {
    writeFileSync(join(this.options.dataDir, "closings", `${record.hash}.json`), JSON.stringify({ closing: record.closing, cosignatures: record.cosignatures }, null, 2) + "\n");
  }

  log(from = 0): { size: number; from: number; entries: Submission[] } {
    const entries = this.witness.entries();
    return { size: entries.length, from, entries: entries.slice(from) };
  }

  async checkpoint(): Promise<Checkpoint> {
    return this.witness.checkpoint(this.options.source.beacon, await this.options.source.latest());
  }

  envelope(id: string): Envelope {
    const file = join(this.options.dataDir, "envelopes", `${id}.json`);
    if (!HEX32.test(id) || !existsSync(file)) throw notFound("envelope");
    return JSON.parse(readFileSync(file, "utf8")) as Envelope;
  }

  /** Everything a verifier needs for one policy, as far as it exists yet. */
  async evidence(hash: string): Promise<EvidenceBundle> {
    const record = this.record(hash);
    const base = { policy: record.policy, policyHash: hash };
    if (!record.closing) return { ...base, state: "open" };
    const entries = this.witness.entries().slice(0, record.closing.size);
    const envelopes: Record<string, Envelope> = {};
    for (const entry of entries) {
      if (entry.policyHash === hash) envelopes[entry.envelopeId] = this.envelope(entry.envelopeId);
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

