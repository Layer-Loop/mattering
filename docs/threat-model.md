# Threat model

Covers sealing. What a witness, a bidder and a coordinator can and cannot do in the auction is set out in [protocol.md](protocol.md) sections 6 and 7 and in [claims.md](claims.md).

## What is protected

The secrecy of a sealed payload until its round, and the integrity of the link between an envelope's header and its payload.

## Attackers

| Attacker | Can | Outcome |
| --- | --- | --- |
| **Reader before the round**, holding the envelope | Try to decrypt early | Fails unless drand's threshold is broken or tlock is broken |
| **Modifier**, who alters an envelope in transit or storage | Change any field | Opening fails. A changed context is only visible while sealed to a verifier who knows the expected context |
| **Replayer** | Move a ciphertext into an envelope with a different round, beacon or context | Opening fails at the frame check |
| **Dishonest sealer** | Name a beacon they control | Rejected by the verifier's beacon policy |
| **Dishonest sealer** | Seal garbage, or a frame that will not open | Not detectable until the round. The envelope is then provably invalid |
| **Dishonest sealer** | Claim after the round that the envelope held something else | `verifyOpen` shows what it opens to |
| **Network attacker** between opener and drand relay | Serve a false signature | Rejected: the signature is verified against the key in the envelope, which the verifier's policy pinned |
| **Network attacker** | Block access to drand | The envelope cannot be opened until a signature is obtained from anywhere. Delay, not disclosure |

## Out of scope, by design

- **The sealer disclosing their own payload.** They know it. No seal can prevent this.
- **Copies made before sealing.** Mattering cannot know who else has the plaintext.
- **A compromised machine** at sealing or opening time.
- **Traffic analysis.** An envelope's size reveals the payload's size to within a few bytes. The context, round and beacon are public.
- **Who sealed it and when.** An envelope is unsigned and undated.

## What breaks everything

| Failure | Effect |
| --- | --- |
| A threshold of drand quicknet operators collude or are compromised | Every envelope for every future round can be opened immediately. This is not detectable |
| drand quicknet stops for good | Envelopes for rounds not yet emitted never open |
| drand's group key is replaced | Unknown. See research question 5 |
| A large quantum computer exists | Every envelope ever published can be opened, whatever its round |
| The envelope file is lost | The payload is gone |
| A flaw in `tlock-js` or `@noble/curves` | Depends on the flaw |

Mattering has no mitigation for any of these. A use that cannot accept them should not use it.

## Known weaknesses in this implementation

1. **No review.** Nobody qualified has examined the construction or the code.
2. **`tlock-js` prints to standard output during decryption.** The core silences `console.log` for the duration of the call. Other code logging at the same moment in the same process loses its output.
3. **`tlock-js` refuses by wall clock** if a round's scheduled time is in the future. The core disables this by passing a schedule that is always in the past, so that opening depends only on the signature. This relies on how the library is written today.
4. **The whole payload is held in memory.** There is no streaming.
5. **The chain hash is not recomputed** from the beacon parameters. Beacons are accepted by exact match against a pinned list.
6. **Cosigners are trusted, not proven, to sign before release.** A cosignature shows a lower bound on the cosigner's time. A policy with no cosigners trusts the witness completely.
7. **A cosigner can be fooled about the time** by an attacker who controls its network and its clock together. Its beacon source rejects a "latest" round far behind schedule by its own clock, and nothing more.
8. **The service is not hardened.** Its key is a file, it has no abuse limits, and it has never been deployed. See [service.md](service.md).
9. **Timing.** No attempt has been made at constant-time behaviour beyond what the libraries do. Opening only handles public inputs, so this is believed not to matter, but it has not been examined.
