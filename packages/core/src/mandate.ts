/**
 * Agent mandates: an organisation's signed statement that an agent's key may
 * negotiate for it, on one side, in one unit, up to a limit, until a time.
 *
 * The limit is the agent's walk-away price, which the other side must not
 * learn. So a mandate carries only a Pedersen commitment to it, which hides the
 * limit and fixes it: nobody can read it from the mandate, and the
 * organisation cannot later claim a different one. The organisation gives the
 * opening (limit and blinding) to its agent privately; shown to an auditor or
 * in a dispute, it proves whether an offer was within the mandate.
 *
 * A mandate says which organisation key signed it. Whether that key really
 * belongs to the organisation named is outside Mattering.
 */
import { assertBeaconInfo, isLowerHex, timeOfRound, type BeaconInfo } from "./beacon.ts";
import { commit, isCommitment, opensTo, randomBlinding } from "./commitment.ts";
import { MatteringError } from "./errors.ts";
import { signCanonical, verifyCanonical, type KeyPair } from "./signing.ts";

export const MANDATE_FORMAT = "mattering.mandate/1";
const MANDATE_LABEL = "mattering/mandate/v1";

export interface Mandate {
  format: typeof MANDATE_FORMAT;
  /** The organisation's Ed25519 public key, which signs the mandate. */
  organisation: string;
  /** The organisation's name, as it states it. Not checked by Mattering. */
  organisationName: string;
  /** The agent's Ed25519 public key: the key that signs its offers. */
  agent: string;
  /** "buyer": the agent may offer up to the limit. "seller": no lower than it. */
  side: "buyer" | "seller";
  unit: string;
  /** Pedersen commitment to the limit, a whole number in `unit`. */
  limit: string;
  /** UNIX seconds after which the mandate no longer authorises anything. */
  expires: number;
  signature: string;
}

/** The secret half of a mandate, held by the organisation and its agent. */
export interface MandateOpening {
  limit: number;
  blinding: string;
}

export interface MandateTerms {
  organisationName: string;
  agent: string;
  side: "buyer" | "seller";
  unit: string;
  limit: number;
  expires: number;
}

/** An organisation authorises an agent. Returns the public mandate and the opening to give the agent privately. */
export function issueMandate(organisation: KeyPair, terms: MandateTerms): { mandate: Mandate; opening: MandateOpening } {
  if (!Number.isSafeInteger(terms.limit) || terms.limit < 0) throw new MatteringError("MALFORMED", "mandate: the limit must be a whole number");
  const blinding = randomBlinding();
  const unsigned: Omit<Mandate, "signature"> = {
    format: MANDATE_FORMAT,
    organisation: organisation.publicKey,
    organisationName: terms.organisationName,
    agent: terms.agent,
    side: terms.side,
    unit: terms.unit,
    limit: commit(terms.limit, blinding),
    expires: terms.expires,
  };
  assertMandateShape(unsigned);
  const mandate = { ...unsigned, signature: signCanonical(MANDATE_LABEL, unsigned, organisation.secretKey) };
  return { mandate, opening: { limit: terms.limit, blinding } };
}

function assertMandateShape(m: Partial<Mandate>, withSignature = false): void {
  if (m === null || typeof m !== "object") throw new MatteringError("MALFORMED", "mandate: not an object");
  const keys = Object.keys(m).sort().join(",");
  const want = withSignature ? "agent,expires,format,limit,organisation,organisationName,side,signature,unit" : "agent,expires,format,limit,organisation,organisationName,side,unit";
  if (keys !== want) throw new MatteringError("MALFORMED", `mandate: unexpected fields (${keys})`);
  if (m.format !== MANDATE_FORMAT) throw new MatteringError("MALFORMED", "mandate.format");
  if (!isLowerHex(m.organisation, 32) || !isLowerHex(m.agent, 32)) throw new MatteringError("MALFORMED", "mandate: keys must be Ed25519 public keys");
  if (m.organisation === m.agent) throw new MatteringError("MALFORMED", "mandate: an organisation key cannot be its own agent");
  if (typeof m.organisationName !== "string" || m.organisationName === "" || typeof m.unit !== "string" || m.unit === "") throw new MatteringError("MALFORMED", "mandate: name and unit");
  if (m.side !== "buyer" && m.side !== "seller") throw new MatteringError("MALFORMED", "mandate.side");
  if (!isCommitment(m.limit)) throw new MatteringError("MALFORMED", "mandate.limit: want a commitment");
  if (!Number.isSafeInteger(m.expires) || m.expires! <= 0) throw new MatteringError("MALFORMED", "mandate.expires: want UNIX seconds");
}

/**
 * What can be checked about a mandate without its opening: well-formed,
 * signed by the organisation key it names, and for this agent, side and unit,
 * still in force at `at` (UNIX seconds). Returns why not, or undefined.
 */
export function mandateProblem(mandate: unknown, expect: { agent: string; side: "buyer" | "seller"; unit: string; at: number }): string | undefined {
  try {
    assertMandateShape(mandate as Partial<Mandate>, true);
  } catch (error) {
    return (error as Error).message;
  }
  const m = mandate as Mandate;
  const { signature, ...unsigned } = m;
  if (!verifyCanonical(MANDATE_LABEL, unsigned, signature, m.organisation)) return "not signed by the organisation key it names";
  if (m.agent !== expect.agent) return "the mandate is for a different agent";
  if (m.side !== expect.side) return `the mandate is to act as ${m.side}`;
  if (m.unit !== expect.unit) return `the mandate is in ${m.unit}`;
  if (m.expires < expect.at) return "the mandate expires before the close";
  return undefined;
}

/** When a policy's bids close, in UNIX seconds: the moment a mandate must still be in force. */
export function closeTime(beacon: BeaconInfo, closeRound: number): number {
  assertBeaconInfo(beacon);
  return timeOfRound(beacon, closeRound);
}

export type MandateStatus = "within" | "beyond" | "undisclosed" | "opening-invalid";

/**
 * Was `price` within the mandate? Needs the opening. A buyer's agent may offer
 * up to the limit, a seller's agent no lower than it. An opening that does not
 * match the commitment proves nothing either way.
 */
export function withinMandate(mandate: Mandate, price: number, opening: MandateOpening | undefined): MandateStatus {
  if (!opening) return "undisclosed";
  if (!Number.isSafeInteger(opening.limit) || typeof opening.blinding !== "string" || !opensTo(mandate.limit, opening.limit, opening.blinding)) return "opening-invalid";
  return (mandate.side === "buyer" ? price <= opening.limit : price >= opening.limit) ? "within" : "beyond";
}
