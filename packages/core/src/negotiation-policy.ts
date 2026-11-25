/**
 * Sealed negotiation, the part a witness needs: the policy format and what can
 * be checked about an offer while it is still sealed. Preparing and judging
 * offers needs recipient encryption and lives in `negotiation.ts`
 * (`@mattering/core/negotiation`), so a witness does not carry it.
 *
 * A negotiation is a chain of steps. In each step the buyer and the seller each
 * seal one offer, to the step's release round and to both parties only. The
 * offers open together, so neither side can see the other's before committing
 * its own, and neither can change its own afterwards. If the buyer's offer
 * meets the seller's, the deal is at the midpoint; otherwise the next step, if
 * the parties make one, starts from scratch.
 */
import { bytesToHex } from "@noble/hashes/utils";
import { isLowerHex } from "./beacon.ts";
import { canonicalEquals, hashCanonical } from "./canonical.ts";
import { isRecipient, isRecipientEnvelope, type Context, type Envelope } from "./envelope.ts";
import { MatteringError } from "./errors.ts";
import { assertTerms, type PolicyTerms } from "./evidence.ts";
import { closeTime, mandateProblem, type Mandate } from "./mandate.ts";
import { verifyEnvelope, type Check, type VerifierPolicy } from "./seal.ts";
import { verifySubmissionSignature, type Submission } from "./witness.ts";

export const NEGOTIATION_POLICY_FORMAT = "mattering.negotiation-policy/1";
export const OFFER_FORMAT = "mattering.offer/1";
const NEGOTIATION_POLICY_LABEL = "mattering/negotiation-policy/v1";

export type Side = "buyer" | "seller";
export const SIDES: readonly Side[] = ["buyer", "seller"];

/** One side of a negotiation: the key that signs its offers, and the age key its offers open to. */
export interface Party {
  /** Ed25519 public key, lowercase hex. Signs this side's submissions. */
  signer: string;
  /** age X25519 recipient (`age1…`). Every offer in the negotiation opens to both parties' recipients. */
  recipient: string;
  /**
   * Optional: the organisation's mandate for this side's agent. Public, so the
   * other side can see who the agent acts for before negotiating; its limit is
   * a commitment, so it cannot see how far the agent may go.
   */
  mandate?: Mandate;
}

export interface NegotiationPolicy extends PolicyTerms {
  format: typeof NEGOTIATION_POLICY_FORMAT;
  /** Names the negotiation; every step carries it. */
  negotiationId: string;
  /** 1 for the first step, then 2, 3, … */
  step: number;
  /** The previous step's policy hash, or "" for step 1. */
  previous: string;
  /** What is being priced, in words. */
  item: string;
  /** The unit prices are in, such as "GBP pence". */
  unit: string;
  /** Offers outside this range are invalid. Whole units. */
  minPrice: number;
  maxPrice: number;
  buyer: Party;
  seller: Party;
  rule: "midpoint-if-crossed";
}

const POLICY_KEYS = "beacon,buyer,closeRound,cosignerThreshold,cosigners,format,item,logFrom,maxPrice,minPrice,negotiationId,origin,previous,releaseRound,rule,seller,step,unit,witness";

function assertParty(party: unknown, field: string): asserts party is Party {
  if (party === null || typeof party !== "object") throw new MatteringError("MALFORMED", `${field}: want { signer, recipient, mandate? }`);
  const p = party as Partial<Party>;
  const keys = Object.keys(p).sort().join(",");
  if (keys !== "recipient,signer" && keys !== "mandate,recipient,signer") throw new MatteringError("MALFORMED", `${field}: want { signer, recipient, mandate? }`);
  if (!isLowerHex(p.signer, 32)) throw new MatteringError("MALFORMED", `${field}.signer: want an Ed25519 public key`);
  if (!isRecipient(p.recipient)) throw new MatteringError("MALFORMED", `${field}.recipient: want an age X25519 recipient`);
}

export function assertNegotiationPolicy(policy: NegotiationPolicy): void {
  const keys = Object.keys(policy).sort().join(",");
  if (keys !== POLICY_KEYS) throw new MatteringError("MALFORMED", `policy: unexpected fields (${keys})`);
  if (policy.format !== NEGOTIATION_POLICY_FORMAT) throw new MatteringError("MALFORMED", "policy.format");
  for (const field of ["negotiationId", "item", "unit"] as const) {
    if (typeof policy[field] !== "string" || policy[field] === "") throw new MatteringError("MALFORMED", `policy.${field}`);
  }
  if (!Number.isSafeInteger(policy.step) || policy.step < 1) throw new MatteringError("MALFORMED", "policy.step: want 1, 2, 3, …");
  if (policy.step === 1 ? policy.previous !== "" : !isLowerHex(policy.previous, 32)) {
    throw new MatteringError("MALFORMED", 'policy.previous: "" for step 1, otherwise the previous step\'s policy hash');
  }
  if (!Number.isSafeInteger(policy.minPrice) || !Number.isSafeInteger(policy.maxPrice) || policy.minPrice < 0 || policy.maxPrice < policy.minPrice) {
    throw new MatteringError("MALFORMED", "policy: price range");
  }
  assertParty(policy.buyer, "policy.buyer");
  assertParty(policy.seller, "policy.seller");
  if (policy.buyer.signer === policy.seller.signer || policy.buyer.recipient === policy.seller.recipient) {
    throw new MatteringError("MALFORMED", "policy: the buyer and the seller need keys of their own");
  }
  if (policy.rule !== "midpoint-if-crossed") throw new MatteringError("MALFORMED", "policy: unsupported rule");
  assertTerms(policy);
  for (const side of SIDES) {
    const mandate = policy[side].mandate;
    if (mandate === undefined) continue;
    const problem = mandateProblem(mandate, { agent: policy[side].signer, side, unit: policy.unit, at: closeTime(policy.beacon, policy.closeRound) });
    if (problem) throw new MatteringError("MALFORMED", `policy.${side}.mandate: ${problem}`);
  }
}

export function negotiationPolicyHash(policy: NegotiationPolicy): string {
  assertNegotiationPolicy(policy);
  return bytesToHex(hashCanonical(NEGOTIATION_POLICY_LABEL, policy));
}

/** Who is making an offer, by the key that signed its submission. Undefined for anyone else. */
export function sideOf(policy: NegotiationPolicy, signer: string): Side | undefined {
  return signer === policy.buyer.signer ? "buyer" : signer === policy.seller.signer ? "seller" : undefined;
}

/** Every offer opens to both parties and nobody else. */
export function offerRecipients(policy: NegotiationPolicy): string[] {
  return [policy.buyer.recipient, policy.seller.recipient].sort();
}

export function offerContext(hash: string, side: Side): Context {
  return { kind: OFFER_FORMAT, policyHash: hash, side };
}

/**
 * What anyone can check about an offer while it is sealed: signed by one of
 * the two parties, for this step, and an envelope locked to the step's release
 * round and to the two parties. Nothing about the price can be checked.
 */
export function verifySealedOffer(policy: NegotiationPolicy, submission: Submission, envelope: Envelope, verifier: VerifierPolicy): Check[] {
  const hash = negotiationPolicyHash(policy);
  const side = sideOf(policy, submission.submitter);
  const sealed = verifyEnvelope(envelope, {
    acceptedBeacons: verifier.acceptedBeacons,
    expectedRound: policy.releaseRound,
    ...(side ? { expectedContext: offerContext(hash, side) } : {}),
  });
  const addressed = isRecipientEnvelope(envelope) && canonicalEquals(envelope.recipients ?? [], offerRecipients(policy));
  return [
    { name: "submission-signed", ok: verifySubmissionSignature(submission) },
    { name: "submission-for-this-policy", ok: submission.policyHash === hash },
    side ? { name: "signed-by-a-party", ok: true } : { name: "signed-by-a-party", ok: false, detail: "the signer is neither the buyer nor the seller" },
    { name: "no-commitment", ok: submission.commitment === undefined },
    ...sealed.checks,
    addressed ? { name: "sealed-to-both-parties", ok: true } : { name: "sealed-to-both-parties", ok: false, detail: "an offer must open to the buyer and the seller, and nobody else" },
    { name: "envelope-is-the-submitted-one", ok: sealed.envelopeId === submission.envelopeId },
  ];
}
