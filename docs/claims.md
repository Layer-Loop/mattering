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
| A8 | **Cosigner independence.** Fewer than the policy's threshold of cosigners collude with the witness, and an honest cosigner's clock is roughly right: the time it puts on a cosignature is when it signed. |
| A9 | **age is sound.** age's X25519 recipient stanzas, header MAC and payload encryption, as implemented in `age-encryption` 0.3.1, are correct. |

## Phase 1: sealing

| # | Claim | Rests on | Assumes | Test (`tests/seal.test.ts` unless noted) | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | A sealed payload cannot be read before its round | tlock encryption to the round | A1, A3, A4, A5 | "premature opening" (both tests); `tests/cli.test.ts` | Shown, against a local test beacon in the offline suite. Against live drand quicknet: `tests/live.test.ts`, run by hand and passed on 2026-11-23 and again on 2026-11-24. It is not part of `npm test`, so re-run it after any change to sealing |
| 2 | The lock is cryptographic, not a clock check in Mattering's code | tlock-js fails with a wrong round's signature even with Mattering's checks bypassed | A3 | "the lock is cryptographic" | Shown |
| 3 | After the round, anyone with the envelope can open it; the sender is not needed | Opening takes the envelope and one public signature | A2, A6 | "opening needs nothing from the sender"; `tests/cli.test.ts` | Shown |
| 4 | Opening does not depend on a Mattering service | The core has no network code except an optional relay fetch | A2 | `tests/cli.test.ts` (signature passed by hand) | Shown |
| 5 | Changing the round, beacon or context of an envelope makes opening fail | Hash of the header is encrypted with the payload | A3, A4 | "tampering with the round / context / beacon", "replay" | Shown |
| 6 | Changing the ciphertext makes opening fail | age header MAC and payload AEAD inside tlock-js | A3, A4 | "tampering with the ciphertext" | Shown |
| 7 | An envelope opens to at most one payload | BLS signatures are unique, so decryption is deterministic | A3, A4 | "verifyOpen rejects a false claim" | Shown for the tested case. The general argument is **unreviewed**: see research question 1 |
| 8 | An envelope has one identifier | Canonical JSON, one accepted armor layout, strict field set | A4 | "file round trip", "non-canonical encodings" | Shown |
| 9 | A seal to a beacon the sender controls is rejected | Verifier policy lists accepted beacons; default is quicknet only | A5 | "a beacon the verifier did not choose" | Shown |
| 10 | If release material cannot be obtained, the envelope stays sealed and says why | No fallback path exists | none | `tests/cli.test.ts` "beacon outage" | Shown |

## Sealing to recipients

Tests are in `tests/recipients.test.ts` and `tests/cli.test.ts`, against a local test beacon.

| # | Claim | Rests on | Assumes | Test | Status |
| --- | --- | --- | --- | --- | --- |
| 40 | A version 2 envelope cannot be read before its round, by its recipients or anyone else | The age file is inside the time lock | A1, A3, A4, A5 | "only the named recipients can read it, and only after the round" | Shown, against a local test beacon. Against live drand quicknet, run by hand on 2026-11-25: no release existed before the round, the recipient opened it after, and a disclosed file key verified |
| 41 | After the round only the named recipients can read it | age X25519 encryption inside the time lock | A1, A4, A9 | same; `tests/cli.test.ts` "sealed to a recipient" | Shown. An outsider's identity and no identity both fail |
| 42 | Who an envelope is for cannot be changed | The recipients are in the header, which the frame binds to the age file | A3, A4 | "who an envelope is for cannot be changed" | Shown |
| 43 | Every recipient who can open an envelope reads the same payload, and a disclosed file key lets anyone check it | age authenticates the whole header under the one file key | A4, A9 | "a recipient can disclose the file key"; "a dishonest sender can shut out a named recipient, but not show recipients different contents" | Shown for the tested attack (one stanza spliced from another file). The general argument is **unreviewed**: research question 16 |
| 44 | A named recipient cannot be shut out | Nothing | none | "a dishonest sender can shut out a named recipient" | **Not provided.** A sender can give a named recipient a stanza that does not open; it shows only at the round, and only to that recipient |

## Sealed negotiation

Tests are in `tests/negotiation.test.ts`, through the witness service with a simulated beacon clock and a cosigner.

| # | Claim | Rests on | Assumes | Test | Status |
| --- | --- | --- | --- | --- | --- |
| 45 | Neither party can read the other's offer before committing its own, nor change its own after | Offers are sealed to the release round, which comes after the close; the log, closed and cosigned before the release, fixes which offers count | A1, A3, A4, A5, A8, A9 | "a deal: both offers sealed to both sides…"; "cheating parties: a second offer…" | Shown. A second offer from the same side does not count |
| 46 | The witness and outsiders cannot read the offers, before or after the release | Offers are version 2 envelopes to the two parties | A1, A4, A9 | "a deal…" (the evidence holds no price; the service gives no result) | Shown |
| 47 | Everyone who can judge a step reaches the same outcome: both parties, and an auditor given a party's file keys | Every recipient who can open an offer reads the same offer (claim 43); the rule is deterministic | A4, A9 | "a deal…"; "cheating parties… shutting the other side out" | Shown. A shut-out party gets "unresolved", not a different outcome, until the file key is disclosed |
| 48 | The witness refuses offers it can tell are wrong while sealed | Signer, step, round, context and addressing checks | none | "the witness refuses offers it can tell are wrong while sealed" | Shown for an outsider, an offer that would also open to a third key, the wrong round, and a late offer |
| 49 | A chain of steps is checked: order, links, unchanged terms, and no step after a deal | `verifyNegotiation` | A4 | "no deal at step 1, a deal at step 2…"; "a deal…" | Shown |
| 50 | A party cannot be shut out of a deal | Nothing | none | "cheating parties… shutting the other side out" | **Not provided.** The other side's offer is unresolved for it until that side discloses its file key, which nothing compels |

## Agent mandates

Tests are in `tests/mandate.test.ts`.

| # | Claim | Rests on | Assumes | Test | Status |
| --- | --- | --- | --- | --- | --- |
| 51 | A mandate is the organisation's: any change to it, or a signature by another key, is detected | Ed25519 signature over the canonical mandate | A4 | "a mandate is signed by the organisation…" | Shown for every field |
| 52 | A witness refuses a negotiation whose mandate is forged, for another agent, side or unit, or expires before the close | Checked when the policy is registered | A4 | "the witness refuses a negotiation whose mandate…" | Shown |
| 53 | The other side cannot learn an agent's limit from its mandate | Pedersen commitments hide the amount | A4 | "a mandate… hides its limit" (the limit is not in it) | Shown in the sense that it is not there; hiding rests on the commitment, **unreviewed** like section 7's |
| 54 | Nobody can move the limit after the mandate is issued | Pedersen commitments bind the amount | A4 | "…hides its limit"; "an agent that goes beyond its mandate…" (a different claimed limit does not open) | Shown |
| 55 | Shown the opening, anyone can tell whether a deal was within the agent's authority | The opening checked against the commitment and the offer | A4, A9 | "a deal within both mandates…"; "an agent that goes beyond its mandate…" | Shown. Without the opening the status is "undisclosed", and the outcome is the same |
| 56 | An agent cannot make an offer beyond its mandate | Only the agent's own software refusing | none | "an agent that goes beyond its mandate…" | **Not provided.** It is detected afterwards, given the opening, not prevented. Proving an offer within the limit without revealing it needs a range proof, not built |

## Phase 2 and 3: witness, commitments, auction

Tests are in `tests/auction.test.ts`. The witness in these tests is an in-process object, not a service.

| # | Claim | Rests on | Assumes | Test | Status |
| --- | --- | --- | --- | --- | --- |
| 11 | A late submission is refused, on the beacon's clock and not the bidder's | The witness closes a policy on seeing its close round by writing a close entry into the log; entries after it do not count | A7 | "late submissions are refused", "an entry appended after the closing checkpoint" | Shown |
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
| 24 | Cryptography and adjudication run without any AI model | No model is called anywhere in `packages/core` or `apps/witness`. In the showcase a model may choose an agent's bid amount and rationale, which are checked as untrusted input | none | whole suite; `tests/showcase.test.ts` "a model that fails, stalls or returns junk", "a model's answer is accepted only if" | Shown |
| 25 | The witness cannot rewrite the log after it can read the bids | The log, up to and including the close entry, must be cosigned by a majority of the policy's cosigners with a time before the release round. A cosigner never cosigns a fork of what it has cosigned (C2SP tlog-witness) | A4, A8 | `tests/service.test.ts` "a witness that rewrites the log", "cosignatures: thresholds…" | Shown for policies that require cosigners, with the cosigner in this repository. With a threshold of 0 it is pure trust in the witness, and the same test shows the forgery succeeding |
| 26 | The witness cannot add an entry between the close round and its close entry | Nothing | A7 | none | **Not provided.** Such an entry is blind (the bids are still sealed) but late |
| 37 | The witness cannot move the closing after it can read the bids | The first close entry for a policy decides; the verifier rejects a closing checkpoint that does not end with it. A log extended after the release is cosigned with a time after the release | A4, A8 | `tests/auction.test.ts` "the first close entry fixes the cutoff"; `tests/service.test.ts` "a witness that rewrites the log" | Shown. Found while moving to public witnesses: their cosignatures date the log but do not say which size closes a policy, so the closing had to go into the log |
| 39 | One log can carry many policies, and a policy's evidence covers only its own stretch of it | The policy names `logFrom`, the log's size when it was made; the verifier rebuilds the closing root from the entries after `logFrom` and the roots of the subtrees covering those before. The witness refuses a `logFrom` beyond its log, so none of the policy's entries can be earlier | A4, A7 | `tests/merkle-tree.test.ts` (the incremental tree against the plain RFC 6962 functions at every size to 70; every prefix and stretch); `tests/shared-log.test.ts` "each auction's evidence covers only its own stretch" | Shown. The argument that leaving out the earlier entries loses nothing is in [protocol.md](protocol.md) section 6, and is **unreviewed** |
| 38 | Mattering's checkpoints, cosignatures and cosigner protocol are those public witnesses use | C2SP signed-note, tlog-checkpoint, tlog-cosignature (Ed25519) and tlog-witness, implemented from the specifications | none | `tests/note.test.ts` (Go reference vectors, byte for byte); `tests/service.test.ts` "cosigners speak C2SP tlog-witness" | Shown for signed notes against Go's vectors. Cosignatures and the protocol are tested only against this repository's own code: **no public witness has been used yet**. ML-DSA-44 cosignatures are not supported |

## The hosted service and registry

Tests are in `tests/service.test.ts`, over HTTP on localhost with a simulated beacon clock.

| # | Claim | Rests on | Assumes | Test | Status |
| --- | --- | --- | --- | --- | --- |
| 27 | An auction can be run through the service and verified from what it publishes | The evidence endpoint returns the verifier's inputs | A7, A8 | "an auction run entirely through the hosted witness" | Shown on localhost. Against live drand: `npm run example:hosted`. Its first run, on 2026-11-23, exposed the stale-relay bug in claim 28. Re-run by hand after the fix the same day: late bid refused, correct winner. Run again on 2026-11-24 after the move to C2SP cosignatures and close entries, and again that day after the log became shared and long-lived: late bid refused, cosignature dated before the release, every check passed. It is not part of `npm test` |
| 28 | The deadline holds without any timer firing, and when a relay serves a stale "latest" round | On every submission the service checks both its beacon view and its own clock against the beacon's schedule | A7; the witness's clock is roughly right | "the deadline holds even when nobody called tick", "a relay that serves a stale 'latest'" | Shown. The second test exists because the first live run accepted a late bid |
| 29 | The service refuses submissions it can tell are wrong while sealed | Signature, policy, envelope id, round and context checks | none | "the witness refuses what it can tell is wrong" | Shown |
| 30 | State survives a restart | Plain files reloaded at start | The disk | "state survives a restart"; `tests/shared-log.test.ts` "the log survives a restart" | Shown, including a restart in the middle of an auction and evidence for released auctions served from storage after they leave memory |
| 31 | A statement was committed before the close and is unchanged | Same log, cosignatures and sealing as bids | A1 to A8 | "registry: sealed statements" | Shown |
| 32 | The registry shows nothing of a commitment before its release round | It serves only envelopes and submissions until the beacon releases | A1, A3 | "registry: sealed statements" | Shown |

## The showcase page

| # | Claim | Rests on | Test | Status |
| --- | --- | --- | --- | --- |
| 33 | The page's result is computed in the browser from evidence, not taken from the server | The page bundles the same library and calls `verifyAuction` itself | `tests/showcase.test.ts` checks the server side; the page was driven in a browser by hand, last on 2026-11-24 against live drand | Shown by hand, not by an automated browser test |
| 34 | A visitor's bid amount never reaches the server | The bid is sealed in the browser before it is sent | Same | Shown by hand |
| 35 | Each cheat button makes a real attempt | The buttons call the library and the service; see [showcase.md](showcase.md) | `tests/showcase.test.ts` covers the late bid and the rewritten log | Shown. The rewrite is signed with the auctioneer's real key and rejected because the cosigned log does not extend it. It is not shown to a cosigner, so that the log's key never signs a fork; a cosigner refusing a fork is claim 25's test. All four were driven by hand in a browser against live drand on 2026-11-24 before rooms shared one log, and in Cloudflare's local runtime with a simulated clock after; each was refused or exposed |

| 57 | The Negotiation Room's outcome is worked out in the browser from evidence and the firms' disclosures, and each cheat makes a real attempt | The page calls `verifyNegotiationStep` and `verifyNegotiation` itself; see [negotiation-room.md](negotiation-room.md) | `tests/negotiation-room.test.ts` (server side, honest and rogue); the page was driven by hand against live drand on 2026-11-25 | Shown by hand, not by an automated browser test. Both agents run on one server, which is staged and said on the page |
| 36 | A language model can choose what a demo agent bids, and nothing more | Its answer is accepted only as an in-range whole amount and a sentence; otherwise a script decides | `tests/showcase.test.ts` (four tests) | Shown with a stand-in model, and the request is tested against a stand-in server. Run by hand against the real Claude API on 2026-11-24 with `claude-opus-5-5`, and worked. The default then changed to `claude-haiku-5-5`, which was also run by hand against the real API that day and worked. Nothing checks the real API automatically |

## Not claimed

| Statement | Why not |
| --- | --- |
| "Trustless" or "fully disintermediated" | Mattering holds no plaintext and no keys, but the design trusts drand for time, a witness to accept submissions, and cosigners not to collude with it |
| "A statement in the registry is that agent's only prediction" | A key can be made freely. One party can commit to every outcome under different keys and show only the right one |
| "The showcase's cosigner is independent" | Until public witnesses cosign the shared log, the only cosigner is run by the auctioneer's operator. The page says so |
| "The service is ready to host" | See the list at the end of [service.md](service.md) |
| "Proves when something was sealed" | An envelope carries no trustworthy time. The witness log says a submission was on time, and that is only as good as the witness (A7) |
| "The witness cannot censor" | A witness can refuse to issue a receipt, and nobody can prove it |
| "The sender cannot leak the payload early" | The sender knows it |
| "Only the recipient can open it", for version 1 envelopes | Version 1 opens to everyone after the round. Version 2 opens to named recipients only (claims 40 to 44) |
| "A recipient key identifies an organisation" | A recipient is an age key. What it stands for is outside Mattering |
| "A mandate proves which organisation an agent acts for" | It proves which organisation key signed it. Tying that key to a real organisation is outside Mattering, and is planned as a separate identity layer |
| "Quantum-safe" or "safe for decades" | tlock is pairing-based. An envelope stored today could be opened by a future quantum computer |
| "Guaranteed to open" | Depends on A2 and A6 |
| "The amount is proven to be in range before opening" | Range proofs are deferred. Without a proof linking them to the ciphertext they would not mean what they appear to mean |
| "Production ready", "audited", "secure" | None of these is true |
