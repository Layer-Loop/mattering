/**
 * The only file that touches the age library (`age-encryption`, by age's
 * author). Mattering does not implement recipient encryption: inside a version
 * 2 envelope's time lock is a standard age file encrypted to X25519
 * recipients (https://age-encryption.org/v1), which any age implementation can
 * open given the identity or the file key.
 *
 * age encrypts the payload under a random 16-byte file key and wraps that key
 * once per recipient. The header, with every wrapped key, is authenticated by
 * a MAC under the file key, so only one file key opens a given file: the
 * property relied on below to let a recipient disclose the file key and let
 * anyone check what the file holds.
 */
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient, type Identity, type Stanza } from "age-encryption";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { MatteringError } from "./errors.ts";
import { isRecipient } from "./envelope.ts";

/** A recipient's key pair: the secret identity (`AGE-SECRET-KEY-1…`) and its public recipient (`age1…`). */
export interface RecipientKeys {
  identity: string;
  recipient: string;
}

export async function generateRecipientKeys(): Promise<RecipientKeys> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** The public recipient for an identity. */
export async function recipientOf(identity: string): Promise<string> {
  assertIdentity(identity);
  try {
    return await identityToRecipient(identity);
  } catch {
    throw new MatteringError("MALFORMED", "identity: not an age X25519 secret key");
  }
}

function assertIdentity(identity: unknown): asserts identity is string {
  if (typeof identity !== "string" || !/^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/.test(identity)) {
    throw new MatteringError("MALFORMED", "identity: want an age X25519 secret key (AGE-SECRET-KEY-1…)");
  }
}

export async function ageEncrypt(recipients: readonly string[], payload: Uint8Array): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  for (const r of recipients) {
    if (!isRecipient(r)) throw new MatteringError("MALFORMED", "recipients: want age X25519 recipients (age1…)");
    encrypter.addRecipient(r);
  }
  return encrypter.encrypt(payload);
}

/** The header of an age file, up to and including its MAC line, and the stanza types in it. */
export function ageHeader(file: Uint8Array): { header: Uint8Array; stanzaTypes: string[] } {
  // The header is ASCII; the MAC line is the first line starting "--- ".
  const text = new TextDecoder("latin1").decode(file.subarray(0, Math.min(file.length, 64 * 1024)));
  const lines = text.split("\n");
  if (lines[0] !== "age-encryption.org/v1") throw new MatteringError("MALFORMED", "inner file: not age v1");
  let length = lines[0].length + 1;
  const stanzaTypes: string[] = [];
  for (const line of lines.slice(1)) {
    length += line.length + 1;
    if (line.startsWith("--- ")) return { header: file.slice(0, length), stanzaTypes };
    if (line.startsWith("-> ")) stanzaTypes.push(line.slice(3).split(" ")[0] ?? "");
  }
  throw new MatteringError("MALFORMED", "inner file: no age header MAC");
}

/** Unwrap the file key with a recipient's identity. Throws DECRYPT_FAILED if this identity cannot. */
export async function ageFileKey(file: Uint8Array, identity: string): Promise<Uint8Array> {
  assertIdentity(identity);
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  try {
    return await decrypter.decryptHeader(ageHeader(file).header);
  } catch {
    throw new MatteringError("DECRYPT_FAILED", "this identity is not a recipient of the envelope, or its key stanza is invalid");
  }
}

/** An identity that already knows the file key: how a disclosed key is checked against the file. */
function fileKeyIdentity(fileKey: Uint8Array): Identity {
  return { unwrapFileKey: (_stanzas: Stanza[]) => fileKey };
}

/**
 * Decrypt with a file key. age checks the header MAC under that key before
 * decrypting, so a wrong key fails rather than producing different content.
 */
export async function ageDecryptWithFileKey(file: Uint8Array, fileKeyHex: string): Promise<Uint8Array> {
  if (typeof fileKeyHex !== "string" || !/^[0-9a-f]{32}$/.test(fileKeyHex)) throw new MatteringError("MALFORMED", "file key: want 16 bytes as lowercase hex");
  const decrypter = new Decrypter();
  decrypter.addIdentity(fileKeyIdentity(hexToBytes(fileKeyHex)));
  try {
    return await decrypter.decrypt(file);
  } catch {
    throw new MatteringError("DECRYPT_FAILED", "the file key does not open this envelope");
  }
}

export async function ageDecryptWithIdentity(file: Uint8Array, identity: string): Promise<Uint8Array> {
  return ageDecryptWithFileKey(file, bytesToHex(await ageFileKey(file, identity)));
}
