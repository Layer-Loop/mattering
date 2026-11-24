# Questions for a cryptographer

The aim is to find where this breaks. Each question says what the code or design currently assumes.

## About what is built

1. **Is an envelope a binding commitment to its payload?** The claim is that a given ciphertext opens to at most one payload, because a round has one valid BLS signature, Boneh-Franklin decryption with the Fujisaki-Okamoto check is deterministic, and the age payload key follows from the file key. ChaCha20-Poly1305 is not key-committing, but the key is not the attacker's to choose after the fact. Is this argument right, and does it survive a malicious sealer who constructs the age file by hand?

2. **Header binding by hash-in-plaintext.** The tlock/age format takes no associated data, so the hash of the header is encrypted in front of the payload and checked after decryption. Is there a cleaner standard construction? Does this give what an AEAD's associated data would give, given that the check happens only at opening?

3. **Is it sound to verify the round's signature ourselves and then pass a fabricated schedule to `tlock-js`** to switch off its wall-clock refusal? The intent is that opening depends on the signature alone.

4. **Is `tlock-js` the right dependency?** Its last release was July 2025 and it has rough edges (it prints the beacon on every decryption and does not check the chain hash in the stanza). Would the Go implementation behind a small service, or a Rust build compiled to WebAssembly, be a sounder base?

5. **What happens to sealed envelopes if drand quicknet's group key changes or the network is retired?** Is there a published commitment about this, and how long a horizon is it reasonable to seal for?

6. **Canonicalization.** Identity is SHA-256 over RFC 8785 JSON, restricted to strings, booleans and safe integers, with one accepted armor layout. Is there a residual malleability in the age file itself (for example in stanza body encoding or trailing data) that gives one ciphertext two identifiers?

## About the witness and the auction

7. **Minimum assumptions for a deadline.** The closing checkpoint cites the close round (a lower bound on its time) and must be countersigned by independent cosigners who refuse after the release round (an upper bound that rests on their honesty). Is cosigning the right tool, or should the checkpoint be anchored to a public ledger instead? What is the weakest anchoring that makes backdating by the witness detectable, and is embedding the drand round worth doing?

8. **Reuse.** The tree is RFC 6962, but the receipt, checkpoint and cosignature formats are ad hoc JSON. Which existing transparency-log format should this adopt instead: RFC 6962, the C2SP checkpoint and tiles specifications, something else?

   *Partly acted on:* checkpoints and cosignatures now use C2SP signed-note, tlog-checkpoint, tlog-cosignature and tlog-witness, so public witnesses can cosign. Receipts and the closing checkpoint are still Mattering JSON. To pin the cutoff, the closing is now an entry in the log (`mattering.close/1`): the first one for a policy decides. Is that the right way to tie an application-level deadline to a transparency log whose witnesses only attest to time and consistency?

9. **Linking a range proof to a time-locked ciphertext.** The design puts the opening of a Pedersen commitment inside the sealed payload, so that the link is checked after release. That makes a range proof before release nearly worthless here, because the ciphertext could hold anything. What is the simplest credible way to prove before release that a tlock ciphertext holds the committed value: verifiable encryption over BLS12-381, a different time-lock construction, a general-purpose proof system? Or is the honest answer that this auction does not need it?

10. **Fairness without an honest coordinator.** Of secrecy, binding, correct adjudication, timely inclusion, censorship resistance and guaranteed opening, which can this design reach, and which need a public ledger?

11. **Composition.** Does combining tlock, Ed25519 signatures, Pedersen commitments on Ristretto255 and labelled SHA-256 create any cross-protocol problem? Are the domain-separation labels sufficient?

12. **Tie-breaking from the release round's signature.** Unknown to bidders at submission, but known to a drand threshold. Is that an acceptable source for this purpose?

13. **Sybil statements.** One party can seal contradictory statements under many keys and later show only the correct one. The registry cannot see this. Is there a minimal mechanism, short of an identity system, that makes a track record mean something?

## About direction

14. **Long-term secrecy.** tlock is not post-quantum. What realistic options exist for sealing over decades, and does combining several beacons improve availability without making early disclosure as easy as breaking the weakest one?

15. **What is over-engineered?** What is the smallest protocol that would still be worth a reviewer's time?
