# Claims register

Every statement about what Mattering guarantees should trace to a row here. If a line is not on this page, do not make it.

**Status** is one of:

- **Shown**: implemented, and a test in this repository demonstrates it under the stated assumption.
- **Designed**: specified in [protocol.md](protocol.md), not built.
- **Not claimed**: Mattering does not provide this. Listed so nobody assumes it.

"Shown" means a test passes. It does not mean a cryptographer has reviewed the construction. Nothing here has been reviewed.

## Assumptions referred to below

| Id | Assumption |
| --- | --- |
| A1 | **drand threshold honesty.** Fewer than a threshold of drand quicknet's operators collude, so a round's signature does not exist before the round. |
| A2 | **drand liveness.** The network keeps emitting rounds, and a round's signature can be obtained from somewhere. |
| A3 | **tlock is sound.** The tlock scheme (eprint 2023/189) and its implementation in `tlock-js` 0.9.0 are correct. |
| A4 | **Standard primitives hold.** SHA-256 is collision resistant; BLS12-381 pairings and ChaCha20-Poly1305 are secure against classical attackers. |
| A5 | **The verifier pins the beacon.** The verifier decides which beacons count as clocks, and does not accept one named by the sender. |
| A6 | **The envelope is available.** Someone still has the envelope file when it is to be opened. |
| A7 | **Witness honesty (Phase 2).** The witness log does not backdate, omit or fork. Forks and omissions of receipted entries are detectable; backdating is not. |

## Phase 1: sealing

| # | Claim | Rests on | Assumes | Test (`tests/seal.test.ts` unless noted) | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | A sealed payload cannot be read before its round | tlock encryption to the round | A1, A3, A4, A5 | "premature opening" (both tests); `tests/cli.test.ts` | Shown, against a local test beacon. Against live drand: `tests/live.test.ts`, which has not been run in the build environment (no network access to drand) |
| 2 | The lock is cryptographic, not a clock check in Mattering's code | tlock-js fails with a wrong round's signature even with Mattering's checks bypassed | A3 | "the lock is cryptographic" | Shown |
| 3 | After the round, anyone with the envelope can open it; the sender is not needed | Opening takes the envelope and one public signature | A2, A6 | "opening needs nothing from the sender"; `tests/cli.test.ts` | Shown |
| 4 | Opening does not depend on a Mattering service | The core has no network code except an optional relay fetch | A2 | `tests/cli.test.ts` (signature passed by hand) | Shown |
| 5 | Changing the round, beacon or context of an envelope makes opening fail | Hash of the header is encrypted with the payload | A3, A4 | "tampering with the round / context / beacon", "replay" | Shown |
| 6 | Changing the ciphertext makes opening fail | age header MAC and payload AEAD inside tlock-js | A3, A4 | "tampering with the ciphertext" | Shown |
| 7 | An envelope opens to at most one payload | BLS signatures are unique, so decryption is deterministic | A3, A4 | "verifyOpen rejects a false claim" | Shown for the tested case. The general argument is **unreviewed**: see research question 1 |
| 8 | An envelope has one identifier | Canonical JSON, one accepted armor layout, strict field set | A4 | "file round trip", "non-canonical encodings" | Shown |
| 9 | A seal to a beacon the sender controls is rejected | Verifier policy lists accepted beacons; default is quicknet only | A5 | "a beacon the verifier did not choose" | Shown |
| 10 | If release material cannot be obtained, the envelope stays sealed and says why | No fallback path exists | none | `tests/cli.test.ts` "beacon outage" | Shown |

## Phase 2 and 3: witness, commitments, auction

| # | Claim | Rests on | Assumes | Status |
| --- | --- | --- | --- | --- |
| 11 | A submission existed before the deadline | Inclusion in a witness log checkpoint that closed before the release round | A7 | Designed |
| 12 | A witness that gave a receipt cannot later drop the entry unnoticed | The receipt is a signed promise; exclusion plus receipt is proof of misbehaviour | Bidder keeps the receipt | Designed |
| 13 | A witness cannot show different logs to different people unnoticed | Signed checkpoints, compared or anchored externally | Someone compares | Designed |
| 14 | A submission cannot be replayed into another auction | Policy hash inside the sealed payload and the signed submission | A4 | Designed |
| 15 | A bidder cannot copy another bidder's sealed bid | Bidder's key inside the sealed payload must match the submission's signer | A4 | Designed |
| 16 | A bidder cannot withdraw or change a bid after seeing others | Opening needs no cooperation from the bidder | A1, A2, A6 | Designed |
| 17 | The published commitment matches the sealed amount | The commitment's opening is inside the sealed payload and checked after release | A4 | Designed. Checked **after** opening only |
| 18 | The winner follows from the policy and the opened bids | Deterministic rule; tie-break from the release round's randomness | A1 | Designed |

## Not claimed

| Statement | Why not |
| --- | --- |
| "Trustless" or "fully disintermediated" | Mattering holds no plaintext and no keys, but the design trusts drand for time and a witness for deadlines |
| "Proves when something was sealed" (Phase 1) | An envelope carries no trustworthy time. Phase 2 adds a witness, under A7 |
| "The witness cannot censor" | A witness can refuse to issue a receipt, and nobody can prove it |
| "The sender cannot leak the payload early" | The sender knows it |
| "Only the recipient can open it" | Opening is public after the round. Recipient encryption is not built |
| "Quantum-safe" or "safe for decades" | tlock is pairing-based. An envelope stored today could be opened by a future quantum computer |
| "Guaranteed to open" | Depends on A2 and A6 |
| "The amount is proven to be in range before opening" | Range proofs are deferred. Without a proof linking them to the ciphertext they would not mean what they appear to mean |
| "Production ready", "audited", "secure" | None of these is true |
