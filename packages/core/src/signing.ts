/** Ed25519 signatures over labelled canonical hashes. Keys are lowercase hex. */
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { isLowerHex } from "./beacon.ts";
import { hashCanonical } from "./canonical.ts";

export interface KeyPair {
  secretKey: string;
  publicKey: string;
}

export function generateKeyPair(secretKey?: string): KeyPair {
  const secret = secretKey ?? bytesToHex(ed25519.utils.randomPrivateKey());
  return { secretKey: secret, publicKey: bytesToHex(ed25519.getPublicKey(hexToBytes(secret))) };
}

/** Sign H(label, canonical(body)). `body` must not contain the signature itself. */
export function signCanonical(label: string, body: unknown, secretKey: string): string {
  return bytesToHex(ed25519.sign(hashCanonical(label, body), hexToBytes(secretKey)));
}

export function verifyCanonical(label: string, body: unknown, signature: unknown, publicKey: unknown): boolean {
  if (!isLowerHex(signature, 64) || !isLowerHex(publicKey, 32)) return false;
  try {
    return ed25519.verify(hexToBytes(signature), hashCanonical(label, body), hexToBytes(publicKey));
  } catch {
    return false;
  }
}
