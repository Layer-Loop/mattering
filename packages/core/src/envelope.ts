/**
 * The sealed envelope: format, strict parsing, header binding and identity.
 *
 * An envelope is public. It carries a drand tlock ciphertext (age format, as
 * produced by drand's tlock-js) and the parameters needed to open it later
 * with nothing but the envelope and one public beacon signature.
 */
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { assertBeaconInfo, assertRound, type BeaconInfo } from "./beacon.ts";
import { assertCanonicalizable, bytesToHex, hashCanonical, type Json } from "./canonical.ts";
import { MatteringError } from "./errors.ts";

export const ENVELOPE_FORMAT = "mattering.envelope/1";
const HEADER_LABEL = "mattering/envelope-header/v1";
const ENVELOPE_LABEL = "mattering/envelope/v1";
/** "MTRG" ‖ frame version 1. */
const FRAME_MAGIC = Uint8Array.of(0x4d, 0x54, 0x52, 0x47, 0x01);

export type Context = { [key: string]: Json };

export interface EnvelopeHeader {
  format: typeof ENVELOPE_FORMAT;
  beacon: BeaconInfo;
  /** The drand round whose signature opens the ciphertext. */
  round: number;
  /** Public, caller-defined metadata. Bound to the ciphertext; not secret. */
  context: Context;
}

export interface Envelope extends EnvelopeHeader {
  /** ASCII-armored age file with a single tlock stanza, in canonical layout. */
  ciphertext: string;
}

export function headerOf(envelope: EnvelopeHeader): EnvelopeHeader {
  return {
    format: envelope.format,
    beacon: { ...envelope.beacon },
    round: envelope.round,
    context: envelope.context,
  };
}

export function headerHash(header: EnvelopeHeader): Uint8Array {
  return hashCanonical(HEADER_LABEL, headerOf(header));
}

/** Stable identifier: hex SHA-256 over the canonical envelope. This is what a log records. */
export function envelopeId(envelope: Envelope): string {
  assertEnvelope(envelope);
  return bytesToHex(hashCanonical(ENVELOPE_LABEL, envelope));
}

export function assertEnvelope(value: unknown): asserts value is Envelope {
  const e = value as Partial<Envelope> | null;
  if (e === null || typeof e !== "object" || Array.isArray(e)) {
    throw new MatteringError("MALFORMED", "envelope: not an object");
  }
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "beacon,ciphertext,context,format,round") {
    throw new MatteringError("MALFORMED", `envelope: unexpected fields (${keys})`);
  }
  if (e.format !== ENVELOPE_FORMAT) throw new MatteringError("MALFORMED", `envelope.format: want ${ENVELOPE_FORMAT}`);
  assertBeaconInfo(e.beacon, "envelope.beacon");
  assertRound(e.round, "envelope.round");
  if (e.context === null || typeof e.context !== "object" || Array.isArray(e.context)) {
    throw new MatteringError("MALFORMED", "envelope.context: want an object");
  }
  assertCanonicalizable(e.context, "envelope.context");
  if (typeof e.ciphertext !== "string") throw new MatteringError("MALFORMED", "envelope.ciphertext: want a string");
  parseArmor(e.ciphertext);
}

export function parseEnvelope(json: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new MatteringError("MALFORMED", "envelope: not JSON");
  }
  assertEnvelope(value);
  return value;
}

/** Pretty JSON for files. Identity is defined over the canonical form, not this text. */
export function serializeEnvelope(envelope: Envelope): string {
  assertEnvelope(envelope);
  return JSON.stringify(envelope, null, 2) + "\n";
}

// --- age armor -------------------------------------------------------------

const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";

// Base64 and Latin-1 without Node's Buffer, so this file also runs in a browser.
function toLatin1(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 8192) out += String.fromCharCode(...data.subarray(i, i + 8192));
  return out;
}

export function base64Encode(data: Uint8Array): string {
  return btoa(toLatin1(data));
}

export function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The one accepted armor layout: 64-column standard base64, "\n" line ends. */
export function armor(data: Uint8Array): string {
  const b64 = base64Encode(data);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return [ARMOR_BEGIN, ...lines, ARMOR_END, ""].join("\n");
}

/**
 * Decode armor, rejecting any text that is not byte-for-byte the canonical
 * layout. Without this, one ciphertext would have many envelope ids.
 */
export function parseArmor(text: string): Uint8Array {
  const lines = text.split("\n");
  if (lines[0] !== ARMOR_BEGIN || lines.length < 4 || lines.at(-1) !== "" || lines.at(-2) !== ARMOR_END) {
    throw new MatteringError("MALFORMED", "ciphertext: not an armored age file");
  }
  const body = lines.slice(1, -2).join("");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new MatteringError("MALFORMED", "ciphertext: bad base64");
  let data: Uint8Array;
  try {
    data = base64Decode(body);
  } catch {
    throw new MatteringError("MALFORMED", "ciphertext: bad base64");
  }
  if (armor(data) !== text) throw new MatteringError("MALFORMED", "ciphertext: armor is not in canonical layout");
  return data;
}

/** The (unauthenticated until opened) tlock stanza arguments in the age header. */
export function readStanza(ciphertext: string): { round: number; chainHash: string } {
  const text = toLatin1(parseArmor(ciphertext));
  const headerEnd = text.indexOf("\n--- ");
  if (headerEnd < 0) throw new MatteringError("MALFORMED", "ciphertext: no age header");
  const lines = text.slice(0, headerEnd).split("\n");
  if (lines[0] !== "age-encryption.org/v1") throw new MatteringError("MALFORMED", "ciphertext: not age v1");
  const stanzas = lines.filter((line) => line.startsWith("-> "));
  const match = /^-> tlock ([1-9][0-9]{0,15}) ([0-9a-f]{64})$/.exec(stanzas[0] ?? "");
  if (stanzas.length !== 1 || !match) {
    throw new MatteringError("MALFORMED", "ciphertext: want exactly one tlock stanza");
  }
  return { round: Number(match[1]), chainHash: match[2]! };
}

// --- plaintext frame ---------------------------------------------------------

/**
 * What is actually encrypted: magic ‖ headerHash ‖ payload. Putting the header
 * hash inside the ciphertext is what binds round, beacon and context to the
 * payload, because the tlock/age format has no associated-data input.
 */
export function frame(header: EnvelopeHeader, payload: Uint8Array): Uint8Array {
  return concatBytes(FRAME_MAGIC, headerHash(header), payload);
}

export function unframe(header: EnvelopeHeader, framed: Uint8Array): Uint8Array {
  const prefix = concatBytes(FRAME_MAGIC, headerHash(header));
  if (framed.length < prefix.length) throw new MatteringError("BINDING", "decrypted content is not a Mattering frame");
  let diff = 0;
  for (let i = 0; i < prefix.length; i++) diff |= framed[i]! ^ prefix[i]!;
  if (diff !== 0) {
    throw new MatteringError("BINDING", "decrypted content is not bound to this envelope's round, beacon and context");
  }
  return framed.slice(prefix.length);
}

