/**
 * Canonical serialization and domain-separated hashing.
 *
 * Canonical form is RFC 8785 (JSON Canonicalization Scheme), restricted to a
 * subset where canonicalization cannot be ambiguous: no null, no floats, no
 * unsafe integers, no ill-formed strings. Everything that is hashed or signed
 * in Mattering goes through `hashCanonical` with a label.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import canonicalizeImport from "canonicalize";
import { MatteringError } from "./errors.ts";

// `canonicalize` is CommonJS; its default export shape differs between loaders.
const canonicalize: (value: unknown) => string | undefined =
  (canonicalizeImport as unknown as { default?: (v: unknown) => string | undefined }).default ??
  (canonicalizeImport as unknown as (v: unknown) => string | undefined);

export type Json = string | number | boolean | Json[] | { [key: string]: Json };

export function assertCanonicalizable(value: unknown, path = "$"): asserts value is Json {
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new MatteringError("MALFORMED", `${path}: ill-formed string`);
    return;
  }
  if (typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new MatteringError("MALFORMED", `${path}: only safe integers are allowed`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertCanonicalizable(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (!key.isWellFormed()) throw new MatteringError("MALFORMED", `${path}: ill-formed key`);
      assertCanonicalizable(item, `${path}.${key}`);
    }
    return;
  }
  throw new MatteringError("MALFORMED", `${path}: unsupported value (null, undefined or non-plain object)`);
}

export function canonicalBytes(value: unknown): Uint8Array {
  assertCanonicalizable(value);
  const text = canonicalize(value);
  if (text === undefined) throw new MatteringError("MALFORMED", "value cannot be canonicalized");
  return utf8ToBytes(text);
}

/** SHA-256(label ‖ 0x00 ‖ data). Labels never contain 0x00. */
export function hashLabelled(label: string, data: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(label), Uint8Array.of(0), data));
}

export function hashCanonical(label: string, value: unknown): Uint8Array {
  return hashLabelled(label, canonicalBytes(value));
}

export function canonicalEquals(a: unknown, b: unknown): boolean {
  return bytesToHex(canonicalBytes(a)) === bytesToHex(canonicalBytes(b));
}

export { bytesToHex };
