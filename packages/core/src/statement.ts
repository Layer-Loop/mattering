/**
 * Sealed statements: commit to some text before a deadline, have it open for
 * everyone at a set round. The registry's basic unit: a prediction, a decision,
 * an answer, recorded before the outcome was known.
 */
import { bytesToHex } from "@noble/hashes/utils";
import type { Release } from "./beacon.ts";
import { canonicalBytes, hashCanonical } from "./canonical.ts";
import { envelopeId, type Context, type Envelope } from "./envelope.ts";
import { MatteringError } from "./errors.ts";
import { assertTerms, verifyEvidence, type Evidence, type PolicyTerms } from "./evidence.ts";
import { open, seal, verifyEnvelope, type Check, type VerifierPolicy } from "./seal.ts";
import type { KeyPair } from "./signing.ts";
import { signSubmission, verifySubmissionSignature, type Submission } from "./witness.ts";

export const STATEMENT_POLICY_FORMAT = "mattering.statement-policy/1";
export const STATEMENT_FORMAT = "mattering.statement/1";
const STATEMENT_POLICY_LABEL = "mattering/statement-policy/v1";
/** Longest statement, in UTF-8 bytes. */
export const MAX_STATEMENT_BYTES = 16_384;

export interface StatementPolicy extends PolicyTerms {
  format: typeof STATEMENT_POLICY_FORMAT;
  /** What statements are being collected about, in words. */
  topic: string;
}

export function assertStatementPolicy(policy: StatementPolicy): void {
  const keys = Object.keys(policy).sort().join(",");
  if (keys !== "beacon,closeRound,cosignerThreshold,cosigners,format,releaseRound,topic,witness") throw new MatteringError("MALFORMED", `policy: unexpected fields (${keys})`);
  if (policy.format !== STATEMENT_POLICY_FORMAT) throw new MatteringError("MALFORMED", "policy.format");
  if (typeof policy.topic !== "string" || policy.topic === "") throw new MatteringError("MALFORMED", "policy.topic");
  assertTerms(policy);
}

export function statementPolicyHash(policy: StatementPolicy): string {
  assertStatementPolicy(policy);
  return bytesToHex(hashCanonical(STATEMENT_POLICY_LABEL, policy));
}

export interface Statement {
  format: typeof STATEMENT_FORMAT;
  policyHash: string;
  author: string;
  text: string;
}

function statementContext(hash: string, author: string): Context {
  return { kind: STATEMENT_FORMAT, policyHash: hash, author };
}

export async function prepareStatement(policy: StatementPolicy, text: string, keys: KeyPair): Promise<{ envelope: Envelope; submission: Submission }> {
  const hash = statementPolicyHash(policy);
  const statement: Statement = { format: STATEMENT_FORMAT, policyHash: hash, author: keys.publicKey, text };
  const payload = canonicalBytes(statement);
  if (payload.length > MAX_STATEMENT_BYTES) throw new MatteringError("MALFORMED", "statement is too long");
  const envelope = await seal({ payload, round: policy.releaseRound, beacon: policy.beacon, context: statementContext(hash, keys.publicKey) });
  return { envelope, submission: signSubmission({ policyHash: hash, envelopeId: envelopeId(envelope) }, keys) };
}

export function verifySealedStatement(policy: StatementPolicy, submission: Submission, envelope: Envelope, verifier: VerifierPolicy): Check[] {
  const hash = statementPolicyHash(policy);
  const sealed = verifyEnvelope(envelope, {
    acceptedBeacons: verifier.acceptedBeacons,
    expectedRound: policy.releaseRound,
    expectedContext: statementContext(hash, submission.submitter),
  });
  return [
    { name: "submission-signed", ok: verifySubmissionSignature(submission) },
    { name: "submission-for-this-policy", ok: submission.policyHash === hash },
    ...sealed.checks,
    { name: "envelope-is-the-submitted-one", ok: sealed.envelopeId === submission.envelopeId },
  ];
}

export interface StatementOutcome {
  index: number;
  author: string;
  envelopeId: string;
  status: "valid" | "invalid" | "unresolved";
  reason?: string;
  text?: string;
}

export interface StatementInputs extends Evidence {
  policy: StatementPolicy;
  envelopes: ReadonlyMap<string, Envelope> | Record<string, Envelope>;
}

export interface StatementsResult {
  /** True iff the evidence is valid. Individual statements may still be invalid or unresolved. */
  ok: boolean;
  checks: Check[];
  statements: StatementOutcome[];
}

async function judge(policy: StatementPolicy, hash: string, submission: Submission, envelope: Envelope, release: Release, verifier: VerifierPolicy): Promise<Pick<StatementOutcome, "status" | "reason" | "text">> {
  const failed = verifySealedStatement(policy, submission, envelope, verifier).find((c) => !c.ok);
  if (failed) return { status: "invalid", reason: `${failed.name}${failed.detail ? `: ${failed.detail}` : ""}` };
  let payload: Uint8Array;
  try {
    payload = await open(envelope, release, { acceptedBeacons: verifier.acceptedBeacons });
  } catch (error) {
    return { status: "invalid", reason: `does not open: ${(error as MatteringError).code}` };
  }
  let statement: Statement;
  try {
    statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as Statement;
    if (bytesToHex(canonicalBytes(statement)) !== bytesToHex(payload)) throw new Error("not canonical");
  } catch {
    return { status: "invalid", reason: "sealed payload is not a canonical statement" };
  }
  if (statement === null || typeof statement !== "object" || Object.keys(statement).sort().join(",") !== "author,format,policyHash,text" || statement.format !== STATEMENT_FORMAT || typeof statement.text !== "string") {
    return { status: "invalid", reason: "sealed payload is not a statement" };
  }
  if (statement.policyHash !== hash) return { status: "invalid", reason: "statement was sealed for a different policy" };
  if (statement.author !== submission.submitter) return { status: "invalid", reason: "statement was sealed by a different author" };
  return { status: "valid", text: statement.text };
}

/** Recompute, from public artifacts, who stated what before the deadline. */
export async function verifyStatements(inputs: StatementInputs, verifier: VerifierPolicy): Promise<StatementsResult> {
  const envelopes = inputs.envelopes instanceof Map ? inputs.envelopes : new Map(Object.entries(inputs.envelopes));
  let hash: string;
  try {
    hash = statementPolicyHash(inputs.policy);
  } catch (error) {
    return { ok: false, checks: [{ name: "policy-well-formed", ok: false, detail: (error as Error).message }], statements: [] };
  }
  const evidence = verifyEvidence(hash, inputs.policy, inputs, verifier);
  const checks: Check[] = [{ name: "policy-well-formed", ok: true }, ...evidence.checks];
  if (!evidence.ok) return { ok: false, checks, statements: [] };
  const statements: StatementOutcome[] = [];
  for (const { index, submission, counts } of evidence.onTime) {
    const base = { index, author: submission.submitter, envelopeId: submission.envelopeId };
    if (!counts) statements.push({ ...base, status: "invalid", reason: "a later submission by the same author" });
    else {
      const envelope = envelopes.get(submission.envelopeId);
      if (!envelope) statements.push({ ...base, status: "unresolved", reason: "envelope not supplied" });
      else statements.push({ ...base, ...(await judge(inputs.policy, hash, submission, envelope, inputs.release, verifier)) });
    }
  }
  return { ok: true, checks, statements };
}
