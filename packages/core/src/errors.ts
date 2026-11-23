/** Every failure the core raises on purpose carries one of these codes. */
export type MatteringErrorCode =
  | "MALFORMED" // input does not have the documented shape or encoding
  | "POLICY" // well-formed, but not acceptable under the verifier's policy
  | "RELEASE_MISMATCH" // release material is for a different round
  | "RELEASE_INVALID" // release material is not a valid beacon signature
  | "DECRYPT_FAILED" // ciphertext did not open under valid release material
  | "BINDING" // decrypted content is not bound to this envelope's header
  | "UNAVAILABLE"; // release material could not be obtained

export class MatteringError extends Error {
  readonly code: MatteringErrorCode;
  constructor(code: MatteringErrorCode, message: string) {
    super(message);
    this.name = "MatteringError";
    this.code = code;
  }
}
