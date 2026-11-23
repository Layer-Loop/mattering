/**
 * Submissions, the witness log, receipts and checkpoints.
 *
 * The witness is the one trusted role in the design: it says what was
 * submitted before a deadline. This file holds both the data formats and
 * their verification (usable by anyone) and a small in-memory `Witness` that
 * a service would wrap. See docs/protocol.md section 6 for what a witness can
 * and cannot get away with.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { isLowerHex, verifyRelease, type BeaconInfo, type Release } from "./beacon.ts";
import { canonicalBytes } from "./canonical.ts";
import { isCommitment } from "./commitment.ts";
import { MatteringError } from "./errors.ts";
import { inclusionProof, leafHash, merkleRoot, rootFromInclusionProof } from "./merkle.ts";
import { generateKeyPair, signCanonical, verifyCanonical, type KeyPair } from "./signing.ts";

export const SUBMISSION_FORMAT = "mattering.submission/1";
export const RECEIPT_FORMAT = "mattering.receipt/1";
export const CHECKPOINT_FORMAT = "mattering.checkpoint/1";
const SUBMISSION_LABEL = "mattering/submission/v1";
const RECEIPT_LABEL = "mattering/receipt/v1";
const CHECKPOINT_LABEL = "mattering/checkpoint/v1";

/** A submitter's signed statement: "this envelope is my entry under this policy". */
export interface Submission {
  format: typeof SUBMISSION_FORMAT;
  policyHash: string;
  envelopeId: string;
  /** Submitter's Ed25519 public key. What that key stands for is outside Mattering. */
  submitter: string;
  /** Pedersen commitment to the sealed amount. */
  commitment: string;
  signature: string;
}

export type UnsignedSubmission = Omit<Submission, "signature">;

export function signSubmission(body: Omit<UnsignedSubmission, "format" | "submitter">, keys: KeyPair): Submission {
  const unsigned: UnsignedSubmission = { format: SUBMISSION_FORMAT, ...body, submitter: keys.publicKey };
  return { ...unsigned, signature: signCanonical(SUBMISSION_LABEL, unsigned, keys.secretKey) };
}

export function isWellFormedSubmission(value: unknown): value is Submission {
  const s = value as Partial<Submission> | null;
  return (
    s !== null &&
    typeof s === "object" &&
    Object.keys(s).sort().join(",") === "commitment,envelopeId,format,policyHash,signature,submitter" &&
    s.format === SUBMISSION_FORMAT &&
    isLowerHex(s.policyHash, 32) &&
    isLowerHex(s.envelopeId, 32) &&
    isLowerHex(s.submitter, 32) &&
    isCommitment(s.commitment) &&
    isLowerHex(s.signature, 64)
  );
}

export function verifySubmissionSignature(submission: Submission): boolean {
  if (!isWellFormedSubmission(submission)) return false;
  const { signature, ...unsigned } = submission;
  return verifyCanonical(SUBMISSION_LABEL, unsigned, signature, submission.submitter);
}

/** The bytes a log leaf holds for a submission. */
export function submissionLeaf(submission: Submission): Uint8Array {
  return canonicalBytes(submission);
}

/** Root over a list of submissions, in log order. */
export function logRoot(entries: readonly Submission[]): string {
  return bytesToHex(merkleRoot(entries.map((e) => leafHash(submissionLeaf(e)))));
}

// --- receipts ----------------------------------------------------------------

/** The witness's signed promise that a submission is entry `index` of a tree of `size`. */
export interface Receipt {
  format: typeof RECEIPT_FORMAT;
  witness: string;
  index: number;
  size: number;
  root: string;
  proof: string[];
  signature: string;
}

/** True iff `witness` signed this receipt and it proves `submission` is in the tree it names. */
export function verifyReceipt(receipt: Receipt, submission: Submission, witness: string): boolean {
  if (receipt?.format !== RECEIPT_FORMAT || receipt.witness !== witness) return false;
  if (!Array.isArray(receipt.proof) || !receipt.proof.every((p) => isLowerHex(p, 32)) || !isLowerHex(receipt.root, 32)) return false;
  const { signature, ...unsigned } = receipt;
  if (!verifyCanonical(RECEIPT_LABEL, unsigned, signature, witness)) return false;
  const root = rootFromInclusionProof(leafHash(submissionLeaf(submission)), receipt.index, receipt.size, receipt.proof.map(hexToBytes));
  return root !== undefined && bytesToHex(root) === receipt.root;
}

/**
 * Does a published log honour a receipt? False is evidence that the witness
 * dropped, moved or replaced an entry it had promised to include.
 */
export function receiptHonoured(receipt: Receipt, submission: Submission, entries: readonly Submission[]): boolean {
  const entry = entries[receipt.index];
  if (!entry || entries.length < receipt.size) return false;
  return (
    bytesToHex(submissionLeaf(entry)) === bytesToHex(submissionLeaf(submission)) &&
    logRoot(entries.slice(0, receipt.size)) === receipt.root
  );
}

// --- checkpoints -------------------------------------------------------------

/**
 * The witness's signed statement of the log's size and root. `observed` is a
 * beacon round signature the witness had seen: proof that the checkpoint was
 * made after that round. `closes` marks the closing checkpoint for a policy.
 */
export interface Checkpoint {
  format: typeof CHECKPOINT_FORMAT;
  witness: string;
  size: number;
  root: string;
  observed: Release;
  closes?: string;
  signature: string;
}

export function verifyCheckpointSignature(checkpoint: Checkpoint, witness: string): boolean {
  if (checkpoint?.format !== CHECKPOINT_FORMAT || checkpoint.witness !== witness) return false;
  if (!Number.isSafeInteger(checkpoint.size) || checkpoint.size < 0 || !isLowerHex(checkpoint.root, 32)) return false;
  const { signature, ...unsigned } = checkpoint;
  return verifyCanonical(CHECKPOINT_LABEL, unsigned, signature, witness);
}

/** Two validly signed checkpoints of the same size with different roots prove a forked log. */
export function isEquivocation(a: Checkpoint, b: Checkpoint, witness: string): boolean {
  return verifyCheckpointSignature(a, witness) && verifyCheckpointSignature(b, witness) && a.size === b.size && a.root !== b.root;
}

// --- a witness ---------------------------------------------------------------

/**
 * An in-memory witness. It appends valid submissions, hands out receipts, and
 * closes a policy when shown the beacon signature for that policy's close
 * round. It does not look inside envelopes and cannot: they are sealed.
 */
export class Witness {
  readonly keys: KeyPair;
  private readonly log: Submission[] = [];
  private readonly closed = new Map<string, Checkpoint>();

  constructor(secretKey?: string) {
    this.keys = generateKeyPair(secretKey);
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  /** The whole log, in order. Public. */
  entries(): Submission[] {
    return this.log.map((e) => ({ ...e }));
  }

  submit(submission: Submission): Receipt {
    if (!verifySubmissionSignature(submission)) throw new MatteringError("MALFORMED", "submission is malformed or its signature is invalid");
    if (this.closed.has(submission.policyHash)) throw new MatteringError("POLICY", "this policy is closed; the submission is late");
    this.log.push({ ...submission });
    const hashes = this.log.map((e) => leafHash(submissionLeaf(e)));
    const index = this.log.length - 1;
    const unsigned: Omit<Receipt, "signature"> = {
      format: RECEIPT_FORMAT,
      witness: this.publicKey,
      index,
      size: this.log.length,
      root: bytesToHex(merkleRoot(hashes)),
      proof: inclusionProof(hashes, index).map(bytesToHex),
    };
    return { ...unsigned, signature: signCanonical(RECEIPT_LABEL, unsigned, this.keys.secretKey) };
  }

  /** Sign the current log state, citing a beacon round the witness has seen. */
  checkpoint(beacon: BeaconInfo, observed: Release, closes?: string): Checkpoint {
    if (!verifyRelease(beacon, observed)) throw new MatteringError("RELEASE_INVALID", "the witness will not cite an invalid beacon signature");
    const base = { format: CHECKPOINT_FORMAT, witness: this.publicKey, size: this.log.length, root: logRoot(this.log), observed } as const;
    const unsigned = closes === undefined ? base : { ...base, closes };
    return { ...unsigned, signature: signCanonical(CHECKPOINT_LABEL, unsigned, this.keys.secretKey) };
  }

  /**
   * Close a policy: called once the witness has seen the policy's close round.
   * Later submissions under the policy are refused. Closing twice returns the
   * same checkpoint.
   */
  close(policyHash: string, beacon: BeaconInfo, closeRoundRelease: Release): Checkpoint {
    const existing = this.closed.get(policyHash);
    if (existing) return existing;
    const checkpoint = this.checkpoint(beacon, closeRoundRelease, policyHash);
    this.closed.set(policyHash, checkpoint);
    return checkpoint;
  }
}
