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
| **Dishonest sealer** | Claim after the round that the envelope held something else | `verifyOpen` shows what it opens to; for a version 2 envelope, `verifyDisclosure` with a recipient's file key |
| **Dishonest sealer** of a version 2 envelope | Readdress it to other recipients | Opening fails at the frame check |
| **Dishonest sealer** of a version 2 envelope | Name a recipient who cannot open it | Not detectable until the round, and then only by that recipient (weakness 12) |
| **Outsider** after the round of a version 2 envelope | Read it | Fails without a recipient's identity or a disclosed file key |
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
6. **Cosigners are trusted, not proven, to sign before release.** The time on a cosignature is the cosigner's own statement. A policy with no cosigners trusts the witness completely.
7. **A cosigner's clock is part of the trust.** One whose clock runs slow, or an attacker who controls that clock, can make a late cosignature look early.
8. **The service is not hardened.** Its key is a file or a deployment secret, it has no abuse limits beyond the demonstration's, and its only deployment is the demonstration, whose log has not yet run for long. See [service.md](service.md).
9. **Timing.** No attempt has been made at constant-time behaviour beyond what the libraries do. Opening only handles public inputs, so this is believed not to matter, but it has not been examined.
10. **No public witness has been used.** The formats are those of the public witness network, and the shared log has been accepted onto its testing list, but no public witness has cosigned it yet, ML-DSA-44 cosignatures are not supported, and the only cosigners that have run are this repository's own.
11. **Evidence leaves out the log before a policy.** A policy's evidence carries the entries from its `logFrom` on and only hashes for those before. The argument that nothing relevant can be in the part left out is in [protocol.md](protocol.md) section 6; it is unreviewed.
12. **Recipients can be shut out.** A version 2 envelope can name a recipient whose key stanza does not open. Nobody can see this before the round, and afterwards only that recipient can, without being able to prove it.
13. **A recipient key is only a key.** Nothing ties an `age1…` recipient to a person or organisation, and an identity file is a secret on disk like any other.
14. **A negotiation shows who is negotiating, and when.** The parties' signing keys, the item, the price range and the timing are public in the policy and the log. Only the offers are sealed.
15. **A party can withhold the outcome.** Outsiders learn a negotiation's outcome only from a party's disclosure, and a party shut out of the other's offer depends on that side disclosing its file key.
16. **A mandate is checked after the fact.** An agent can make an offer beyond its mandate; it is detected only when someone shown the limit's opening judges the step. An organisation key is only a key: nothing ties it to the organisation it names.
17. **Through the MCP server, Mattering holds every party's keys.** Tables and auctions run by assistants are server-sealed: the server seals offers and bids for the parties, so it could read or forge any of them. Tokens and invites travel through the assistants' conversations, and anyone who can read those can act for that party. Anyone with a negotiation's watch link sees each round's offers once it opens, and the notes and both limits once it has ended. See [mcp.md](mcp.md).
18. **A server-sealed platform session trusts Mattering.** The same holds for any session created with `sealing: "server"`. Every response says so in `trust`; client sealing, the default, is the remedy.
19. **The organiser reads every bid.** In an auction under `organiser` confidentiality the organiser opens all bids after release, and in a client-sealed negotiation the organiser and Mattering see each round's offers once a side discloses them, which the engine needs in order to go on. This is assumption 9 in [api-design.md](api-design.md), section 13.
20. **Mattering can stall a session.** It can refuse a bid, never open a round, or never publish a result. It cannot make a sealed bid readable early, change one, or publish a result the evidence contradicts without being caught by a client that verifies (`@mattering/client` does).
21. **Credentials are bearer secrets.** API keys, participant tokens and webhook secrets act for whoever holds them. API keys are kept by the hosted service only as hashes (a Worker secret holds older ones), and tokens are stored by the session's Durable Object. None is tied to a person or organisation: participants are keys and the integrator's labels (assumption 5).
22. **An integrator's own data is unchecked.** Labels and metadata are whatever the integrator or participant sends, and are shown back as given.
