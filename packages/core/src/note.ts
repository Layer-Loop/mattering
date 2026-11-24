/**
 * The transparency-log formats public witnesses speak, implemented exactly as
 * specified and nothing more:
 *
 *   C2SP signed-note       https://c2sp.org/signed-note       (Ed25519, type 0x01)
 *   C2SP tlog-checkpoint   https://c2sp.org/tlog-checkpoint
 *   C2SP tlog-cosignature  https://c2sp.org/tlog-cosignature  (Ed25519 cosignature/v1, type 0x04)
 *
 * ML-DSA-44 cosignatures (type 0x06), which the witness spec recommends for new
 * witnesses, are not supported yet: their signatures are ignored like any
 * unknown key's. Nothing here is new cryptography; the byte layouts follow the
 * specifications and the Go reference implementations.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { isLowerHex } from "./beacon.ts";
import { MatteringError } from "./errors.ts";

export const SIGNATURE_ED25519 = 0x01;
export const COSIGNATURE_ED25519 = 0x04;

// --- base64, canonical only (RFC 4648 section 4, padded) ---------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    out += b === undefined ? "==" : ALPHABET[(n >> 6) & 63]! + (c === undefined ? "=" : ALPHABET[n & 63]!);
  }
  return out;
}

/** Decode base64, refusing anything but the one canonical encoding. */
export function fromBase64(text: string): Uint8Array | undefined {
  if (!BASE64.test(text)) return undefined;
  const clean = text.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let j = 0;
  for (const ch of clean) {
    value = (value << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[j++] = (value >> bits) & 0xff;
    }
  }
  // Non-zero leftover bits would make a second spelling of the same bytes.
  return toBase64(bytes) === text ? bytes : undefined;
}

// --- keys --------------------------------------------------------------------

/** A key name: what a note signature line calls its signer. A log's name is its origin. */
export function isKeyName(name: unknown): name is string {
  return typeof name === "string" && name !== "" && utf8ToBytes(name).length <= 255 && !/[\s+\u0000-\u001f\u007f]/u.test(name) && name.isWellFormed();
}

/** SHA-256(name ‖ 0x0A ‖ type ‖ public key)[:4], as lowercase hex. */
export function noteKeyId(name: string, type: number, publicKey: string): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes(name), Uint8Array.of(0x0a, type), hexToBytes(publicKey))).slice(0, 4));
}

/** A verifier key: who signs, with which kind of signature, and the public key. */
export interface NoteKey {
  name: string;
  type: typeof SIGNATURE_ED25519 | typeof COSIGNATURE_ED25519;
  /** Ed25519 public key, lowercase hex. */
  publicKey: string;
}

/** `<name>+<key id hex>+base64(type ‖ public key)`, the form logs and witnesses publish. */
export function formatVkey(key: NoteKey): string {
  if (!isKeyName(key.name) || !isLowerHex(key.publicKey, 32)) throw new MatteringError("MALFORMED", "verifier key");
  return `${key.name}+${noteKeyId(key.name, key.type, key.publicKey)}+${toBase64(concatBytes(Uint8Array.of(key.type), hexToBytes(key.publicKey)))}`;
}

export function parseVkey(vkey: unknown): NoteKey {
  // The key itself is base64 and may contain "+"; only the first two separate fields.
  const match = typeof vkey === "string" ? /^([^+]*)\+([^+]*)\+(.*)$/s.exec(vkey) : null;
  const [, name, id, encoded] = match ?? [];
  const bytes = encoded === undefined ? undefined : fromBase64(encoded);
  if (!match || !isKeyName(name) || !/^[0-9a-f]{8}$/.test(id!) || bytes?.length !== 33) throw new MatteringError("MALFORMED", "verifier key: want <name>+<id>+<key>");
  const type = bytes[0]!;
  if (type !== SIGNATURE_ED25519 && type !== COSIGNATURE_ED25519) throw new MatteringError("MALFORMED", "verifier key: only Ed25519 keys (types 0x01 and 0x04) are supported");
  const publicKey = bytesToHex(bytes.slice(1));
  if (noteKeyId(name, type, publicKey) !== id) throw new MatteringError("MALFORMED", "verifier key: key id does not match");
  return { name, type, publicKey };
}

// --- signed notes ------------------------------------------------------------

export interface NoteSignature {
  name: string;
  /** The 4-byte key id, lowercase hex. */
  keyId: string;
  /** Everything after the key id. */
  signature: Uint8Array;
}

export interface SignedNote {
  /** The signed text, ending in a newline. */
  text: string;
  signatures: NoteSignature[];
}

const SIGNATURE_PREFIX = "— ";
const MAX_SIGNATURES = 100;

export function signatureLine(name: string, keyId: string, signature: Uint8Array): string {
  return `${SIGNATURE_PREFIX}${name} ${toBase64(concatBytes(hexToBytes(keyId), signature))}\n`;
}

/** Split a signed note into its text and signature lines. Verifies nothing. */
export function parseNote(note: unknown): SignedNote {
  if (typeof note !== "string" || !note.isWellFormed() || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(note)) throw new MatteringError("MALFORMED", "note: not text");
  const split = note.lastIndexOf("\n\n");
  if (split < 0 || !note.endsWith("\n")) throw new MatteringError("MALFORMED", "note: no signatures");
  const text = note.slice(0, split + 1);
  const lines = note.slice(split + 2, -1).split("\n");
  if (lines.length > MAX_SIGNATURES) throw new MatteringError("MALFORMED", "note: too many signatures");
  const signatures = lines.map((line) => {
    const [name, encoded, extra] = line.startsWith(SIGNATURE_PREFIX) ? line.slice(SIGNATURE_PREFIX.length).split(" ") : [];
    const bytes = encoded === undefined ? undefined : fromBase64(encoded);
    if (!isKeyName(name) || extra !== undefined || bytes === undefined || bytes.length < 5) throw new MatteringError("MALFORMED", "note: bad signature line");
    return { name, keyId: bytesToHex(bytes.slice(0, 4)), signature: bytes.slice(4) };
  });
  return { text, signatures };
}

/** An Ed25519 (type 0x01) signature line over `text`. */
export function signNote(text: string, name: string, secretKey: string): string {
  if (!text.endsWith("\n")) throw new MatteringError("MALFORMED", "note text must end in a newline");
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(secretKey)));
  return signatureLine(name, noteKeyId(name, SIGNATURE_ED25519, publicKey), ed25519.sign(utf8ToBytes(text), hexToBytes(secretKey)));
}

/** True iff the note carries a valid type 0x01 signature from `key`. */
export function verifyNoteSignature(note: SignedNote, key: NoteKey): boolean {
  if (key.type !== SIGNATURE_ED25519) return false;
  const id = noteKeyId(key.name, SIGNATURE_ED25519, key.publicKey);
  return note.signatures.some((s) => s.name === key.name && s.keyId === id && s.signature.length === 64 && safeVerify(s.signature, utf8ToBytes(note.text), key.publicKey));
}

function safeVerify(signature: Uint8Array, message: Uint8Array, publicKey: string): boolean {
  try {
    return ed25519.verify(signature, message, hexToBytes(publicKey));
  } catch {
    return false;
  }
}

// --- checkpoints -------------------------------------------------------------

export interface CheckpointBody {
  origin: string;
  size: number;
  /** The RFC 6962 root, lowercase hex. */
  root: string;
  extensions: string[];
}

export function checkpointText(origin: string, size: number, root: string): string {
  if (!isKeyName(origin) || !Number.isSafeInteger(size) || size < 0 || !isLowerHex(root, 32)) throw new MatteringError("MALFORMED", "checkpoint");
  return `${origin}\n${size}\n${toBase64(hexToBytes(root))}\n`;
}

export function parseCheckpointText(text: string): CheckpointBody {
  const lines = text.split("\n");
  const [origin, size, root] = lines;
  const rootBytes = root === undefined ? undefined : fromBase64(root);
  const extensions = lines.slice(3, -1);
  if (lines.length < 4 || lines.at(-1) !== "" || !isKeyName(origin) || !/^(0|[1-9][0-9]*)$/.test(size!) || !Number.isSafeInteger(Number(size)) || rootBytes?.length !== 32 || extensions.some((e) => e === "")) {
    throw new MatteringError("MALFORMED", "not a checkpoint");
  }
  return { origin, size: Number(size), root: bytesToHex(rootBytes), extensions };
}

// --- cosignatures ------------------------------------------------------------

/** The bytes an Ed25519 checkpoint cosignature signs. */
export function cosignatureMessage(timestamp: number, text: string): Uint8Array {
  return utf8ToBytes(`cosignature/v1\ntime ${timestamp}\n${text}`);
}

/** The key id a cosigner's key has in cosignature lines, whatever type its vkey was published as. */
export function cosignerKeyId(key: NoteKey): string {
  return noteKeyId(key.name, COSIGNATURE_ED25519, key.publicKey);
}

/** A cosignature line: key id ‖ timestamp (u64, big-endian) ‖ Ed25519 signature. */
export function cosign(text: string, name: string, secretKey: string, timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new MatteringError("MALFORMED", "timestamp");
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(secretKey)));
  const time = new Uint8Array(8);
  new DataView(time.buffer).setBigUint64(0, BigInt(timestamp));
  const signature = ed25519.sign(cosignatureMessage(timestamp, text), hexToBytes(secretKey));
  return signatureLine(name, cosignerKeyId({ name, type: COSIGNATURE_ED25519, publicKey }), concatBytes(time, signature));
}

/**
 * The time `key` says it cosigned this checkpoint, or undefined if the note
 * has no valid cosignature from it. A cosignature asserts that, as of that
 * time, this was the largest tree the cosigner had seen for the log and that
 * it is consistent with every earlier one it saw.
 */
export function cosignatureTime(note: SignedNote, key: NoteKey): number | undefined {
  const id = cosignerKeyId(key);
  for (const s of note.signatures) {
    if (s.name !== key.name || s.keyId !== id || s.signature.length !== 72) continue;
    const timestamp = new DataView(s.signature.buffer, s.signature.byteOffset).getBigUint64(0);
    if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    if (safeVerify(s.signature.slice(8), cosignatureMessage(Number(timestamp), note.text), key.publicKey)) return Number(timestamp);
  }
  return undefined;
}
