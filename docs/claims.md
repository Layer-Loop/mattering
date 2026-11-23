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
| A7 | **Witness honesty.** The witness does not refuse submissions. For a policy with no cosigners, it also does not rewrite the log after release. Dropping a receipted entry and forking the log are detectable; these are not. |
| A8 | **Cosigner independence.** Fewer than the policy's threshold of cosigners collude with the witness, and an honest cosigner's view of the beacon is current. |

## Phase 1: sealing

| # | Claim | Rests on | Assumes | Test (`tests/seal.test.ts` unless noted) | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | A sealed payload cannot be read before its round | tlock encryption to the round | A1, A3, A4, A5 | "premature opening" (both tests); `tests/cli.test.ts` | Shown, against a local test beacon in the offline suite. Against live drand quicknet: `tests/live.test.ts`, run by hand and passed on 2026-11-23. It is not part of `npm test`, so re-run it after any change to sealing |
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

Tests are in `tests/auction.test.ts`. The witness in these tests is an in-process object, not a service.

| # | Claim | Rests on | Assumes | Test | Status |
| --- | --- | --- | --- | --- | --- |
| 11 | A late submission is refused, on the beacon's clock and not the bidder's | The witness closes a policy on seeing its close round; entries past the closing size do not count | A7 | "late submissions are refused", "an entry appended after the closing checkpoint" | Shown |
| 12 | A witness cannot close early | The closing checkpoint must cite the close round's signature | A1, A4 | "a witness cannot close early" | Shown |
| 13 | A witness that gave a receipt cannot later drop the entry unnoticed | Receipt is a signed inclusion proof; the verifier recomputes the log root | Bidder keeps the receipt | "receipts: … a dropped entry is provable" | Shown |
| 14 | A forked log is provable | Two signed checkpoints of one size with different roots | Someone compares them | "a forked log is provable" | Shown. Nothing compares checkpoints automatically |
| 15 | A submission cannot be replayed into another auction | Policy hash inside the sealed bid and the signed submission | A3, A4 | "replay" | Shown |
| 16 | Copying a rival's sealed bid gains nothing and cannot void the original | Bidder's key inside the sealed bid must match the submission's signer | A3, A4 | "copying" | Shown |
| 17 | A bidder cannot withdraw or change a bid after the close | Opening needs nothing from the bidder; one bid per key | A1, A2, A6, A7 | "bidders vanish", "one bid per bidder" | Shown |
| 18 | Bids cannot be read before the release round, including by the witness and the coordinator | Claim 1 | A1, A3, A4, A5 | "before release" | Shown, against a local test beacon |
| 19 | A commitment that does not match the sealed amount is caught | The commitment's opening is inside the sealed bid | A4 | "substitution" | Shown. Caught **after** opening only; before opening it is undetectable, and the test shows that too |
| 20 | Out-of-range and malformed bids are rejected without stopping the auction | Deterministic checks on the opened bid | none | "boundary bids", "garbage in a well-formed envelope" | Shown. The amount of an invalid bid becomes public at opening like every other |
| 21 | The winner follows from the policy and the evidence, and anyone can recompute it | Deterministic verifier; tie-break from the release round's signature | A1 | "three bidders", "ties", "coordinator announces the wrong winner"; `npm run example:verify` | Shown |
| 22 | A coordinator who withholds or swaps an envelope cannot change the result, only block it | An envelope is identified by its hash; a missing or wrong one leaves the bid unresolved and the auction without a result | A4 | "coordinator withholds an envelope", "coordinator swaps an envelope" | Shown. An earlier version treated a swapped envelope as an invalid bid, which let a coordinator void the top bid; fixed |
| 23 | A coordinator cannot substitute the policy or the release signature | Policy hash and signature checks | A4 | "coordinator swaps an envelope or edits the policy" | Shown |
| 24 | Cryptography and adjudication run without any AI model | No model is called anywhere in `packages/core`; the example's agents are plain functions | none | whole suite | Shown |
| 25 | The witness cannot rewrite the log after it can read the bids | The closing checkpoint must be countersigned before the release round by the policy's cosigners, who sign one checkpoint per policy | A8 | `tests/service.test.ts` "a witness that rewrites the log", "cosigners" | Shown for policies that require cosigners. With a threshold of 0 it is pure trust in the witness, and the same test shows the forgery succeeding |
| 26 | The witness cannot add an entry between the close round and the cosignatures | Nothing | A7 | none | **Not provided.** Such an entry is blind (the bids are still sealed) but late |

## The hosted service and registry

Tests are in `tests/service.test.ts`, over HTTP on localhost with a simulated beacon clock.

| # | Claim | Rests on | Assumes | Test | Status |
| --- | --- | --- | --- | --- | --- |
| 27 | An auction can be run through the service and verified from what it publishes | The evidence endpoint returns the verifier's inputs | A7, A8 | "an auction run entirely through the hosted witness" | Shown on localhost. Against live drand: `npm run example:hosted`. Its first run, on 2026-11-23, exposed the stale-relay bug in claim 28. Re-run by hand after the fix the same day: late bid refused, correct winner. It is not part of `npm test` |
| 28 | The deadline holds without any timer firing, and when a relay serves a stale "latest" round | On every submission the service checks both its beacon view and its own clock against the beacon's schedule | A7; the witness's clock is roughly right | "the deadline holds even when nobody called tick", "a relay that serves a stale 'latest'" | Shown. The second test exists because the first live run accepted a late bid |
| 29 | The service refuses submissions it can tell are wrong while sealed | Signature, policy, envelope id, round and context checks | none | "the witness refuses what it can tell is wrong" | Shown |
| 30 | State survives a restart | Plain files reloaded at start | The disk | "state survives a restart" | Shown |
| 31 | A statement was committed before the close and is unchanged | Same log, cosignatures and sealing as bids | A1 to A8 | "registry: sealed statements" | Shown |
| 32 | The registry shows nothing of a commitment before its release round | It serves only envelopes and submissions until the beacon releases | A1, A3 | "registry: sealed statements" | Shown |

## The showcase page

| # | Claim | Rests on | Test | Status |
| --- | --- | --- | --- | --- |
| 33 | The page's result is computed in the browser from evidence, not taken from the server | The page bundles the same library and calls `verifyAuction` itself | `tests/showcase.test.ts` checks the server side; the page was driven once in a headless browser by hand | Shown by hand, not by an automated browser test |
| 34 | A visitor's bid amount never reaches the server | The bid is sealed in the browser before it is sent | Same | Shown by hand |
| 35 | Each cheat button makes a real attempt | The buttons call the library and the service; see [showcase.md](showcase.md) | `tests/showcase.test.ts` covers the late bid and the rewritten log | Shown |

## Not claimed

| Statement | Why not |
| --- | --- |
| "Trustless" or "fully disintermediated" | Mattering holds no plaintext and no keys, but the design trusts drand for time, a witness to accept submissions, and cosigners not to collude with it |
| "A statement in the registry is that agent's only prediction" | A key can be made freely. One party can commit to every outcome under different keys and show only the right one |
| "The showcase's cosigner is independent" | It runs in the same process as the auctioneer. The page says so |
| "The service is ready to host" | See the list at the end of [service.md](service.md) |
| "Proves when something was sealed" | An envelope carries no trustworthy time. The witness log says a submission was on time, and that is only as good as the witness (A7) |
| "The witness cannot censor" | A witness can refuse to issue a receipt, and nobody can prove it |
| "The sender cannot leak the payload early" | The sender knows it |
| "Only the recipient can open it" | Opening is public after the round. Recipient encryption is not built |
| "Quantum-safe" or "safe for decades" | tlock is pairing-based. An envelope stored today could be opened by a future quantum computer |
| "Guaranteed to open" | Depends on A2 and A6 |
| "The amount is proven to be in range before opening" | Range proofs are deferred. Without a proof linking them to the ciphertext they would not mean what they appear to mean |
| "Production ready", "audited", "secure" | None of these is true |
