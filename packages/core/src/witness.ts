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
import { consistencyProof, inclusionProof, leafHash, merkleRoot, rootFromInclusionProof } from "./merkle.ts";
import { SIGNATURE_ED25519, checkpointText, formatVkey, isKeyName, signNote, toBase64 } from "./note.ts";
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
  /** Pedersen commitment to a sealed amount, where the policy calls for one. */
  commitment?: string;
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
    ["commitment,envelopeId,format,policyHash,signature,submitter", "envelopeId,format,policyHash,signature,submitter"].includes(Object.keys(s).sort().join(",")) &&
    s.format === SUBMISSION_FORMAT &&
    isLowerHex(s.policyHash, 32) &&
    isLowerHex(s.envelopeId, 32) &&
    isLowerHex(s.submitter, 32) &&
    (s.commitment === undefined ? !("commitment" in s) : isCommitment(s.commitment)) &&
    isLowerHex(s.signature, 64)
  );
}

export function verifySubmissionSignature(submission: Submission): boolean {
  if (!isWellFormedSubmission(submission)) return false;
  const { signature, ...unsigned } = submission;
  return verifyCanonical(SUBMISSION_LABEL, unsigned, signature, submission.submitter);
}

// --- close entries -----------------------------------------------------------

export const CLOSE_FORMAT = "mattering.close/1";

/**
 * Written into the log by the witness when it closes a policy. The first one
 * for a policy fixes which entries count: those before it. Because it is in
 * the log, the cosignatures that date the log also date the closing, so the
 * witness cannot choose its cutoff after the bids open.
 */
export interface CloseEntry {
  format: typeof CLOSE_FORMAT;
  policyHash: string;
  /** The beacon's signature for the policy's close round. */
  observed: Release;
}

/** One leaf of the log. */
export type LogEntry = Submission | CloseEntry;

export function isCloseEntry(entry: unknown): entry is CloseEntry {
  return (entry as CloseEntry | null)?.format === CLOSE_FORMAT;
}

export function isSubmission(entry: unknown): entry is Submission {
  return (entry as Submission | null)?.format === SUBMISSION_FORMAT;
}

/** The bytes a log leaf holds for an entry. */
export function submissionLeaf(entry: LogEntry): Uint8Array {
  return canonicalBytes(entry);
}

/** Root over a list of entries, in log order. */
export function logRoot(entries: readonly LogEntry[]): string {
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
export function receiptHonoured(receipt: Receipt, submission: Submission, entries: readonly LogEntry[]): boolean {
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

/** The origin a witness's log gets when none is configured: unique to its key. */
export function defaultOrigin(publicKey: string): string {
  return `mattering.invalid/log/${publicKey.slice(0, 16)}`;
}

/**
 * An in-memory witness. It appends valid submissions, hands out receipts, and
 * closes a policy when shown the beacon signature for that policy's close
 * round. It does not look inside envelopes and cannot: they are sealed.
 */
export class Witness {
  readonly keys: KeyPair;
  /**
   * The log's name in the C2SP formats, which public witnesses know it by.
   * Policies name it, so that one witness cannot run two logs side by side
   * and pick one after the bids open.
   */
  readonly origin: string;
  private readonly log: LogEntry[] = [];
  private readonly closed = new Map<string, Checkpoint>();

  /** Pass previously persisted state to resume a log. */
  constructor(secretKey?: string, state?: { entries: readonly LogEntry[]; closings: Iterable<[string, Checkpoint]> }, origin?: string) {
    this.keys = generateKeyPair(secretKey);
    this.origin = origin ?? defaultOrigin(this.keys.publicKey);
    if (!isKeyName(this.origin)) throw new MatteringError("MALFORMED", "origin: want a key name, such as example.com/log");
    if (state) {
      this.log.push(...state.entries.map((e) => ({ ...e })));
      for (const [hash, checkpoint] of state.closings) this.closed.set(hash, checkpoint);
    }
  }

  get size(): number {
    return this.log.length;
  }

  closingOf(policyHash: string): Checkpoint | undefined {
    return this.closed.get(policyHash);
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  /** The log's verifier key, as witnesses are configured with it. */
  get vkey(): string {
    return formatVkey({ name: this.origin, type: SIGNATURE_ED25519, publicKey: this.publicKey });
  }

  /** A C2SP checkpoint of the log at `size` (default: now), signed by this witness. */
  logCheckpoint(size = this.log.length): string {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.log.length) throw new MatteringError("MALFORMED", "size out of range");
    const text = checkpointText(this.origin, size, logRoot(this.log.slice(0, size)));
    return text + "\n" + signNote(text, this.origin, this.keys.secretKey);
  }

  /** RFC 6962 consistency proof between two sizes of this log, as base64 lines. */
  consistency(oldSize: number, newSize = this.log.length): string[] {
    if (!Number.isSafeInteger(newSize) || newSize > this.log.length) throw new MatteringError("MALFORMED", "size out of range");
    return consistencyProof(this.log.slice(0, newSize).map((e) => leafHash(submissionLeaf(e))), oldSize).map(toBase64);
  }

  /** The whole log, in order. Public. */
  entries(): LogEntry[] {
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
   * Appends a close entry, so the closing is part of the log, then signs a
   * closing checkpoint ending with it. Later submissions under the policy are
   * refused. Closing twice returns the same checkpoint.
   */
  close(policyHash: string, beacon: BeaconInfo, closeRoundRelease: Release): Checkpoint {
    const existing = this.closed.get(policyHash);
    if (existing) return existing;
    if (!verifyRelease(beacon, closeRoundRelease)) throw new MatteringError("RELEASE_INVALID", "the witness will not cite an invalid beacon signature");
    this.log.push({ format: CLOSE_FORMAT, policyHash, observed: closeRoundRelease });
    const checkpoint = this.checkpoint(beacon, closeRoundRelease, policyHash);
    this.closed.set(policyHash, checkpoint);
    return checkpoint;
  }
}
