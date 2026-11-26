# @mattering/core

> **Proof of concept. Not yet security reviewed. Do not protect anything valuable with it.**

Seal data until a future time, and let anyone check the seal and the opening. Sealing is locked to a round of [drand](https://drand.love)'s public randomness beacon: before the round, the key that opens the seal does not exist, for anyone. After it, anyone holding the seal can open it, with no account and no service.

The library also covers what a deadline needs: a witness log with signed receipts, cosignatures in the C2SP formats public transparency-log witnesses use, sealed-bid auctions and sealed negotiations that anyone can work out again from the published evidence, sealing to named recipients, and agent mandates with committed limits.

Runs in Node.js 22 or later and in browsers.

## Install

```bash
npm install @mattering/core
```

## Seal and open

```ts
import { seal, open, firstRoundAtOrAfter, QUICKNET } from "@mattering/core";
import { fetchRelease } from "@mattering/core/drand-http";

// Sealed here, until 10:00 UTC on 1 March 2027.
const round = firstRoundAtOrAfter(QUICKNET, Date.parse("2027-03-01T10:00:00Z") / 1000);
const sealed = await seal({ payload: new TextEncoder().encode("our bid: £4,200"), round });

// Fails before 10:00. After it, anyone holding `sealed` can open it.
const payload = await open(sealed, await fetchRelease(QUICKNET, round));
```

## Entry points

| Import | What it holds |
| --- | --- |
| `@mattering/core` | Sealing and opening, envelopes, the witness log and receipts, signed notes and cosignatures, auctions, sealed statements, negotiation policies, mandates, commitments, Merkle proofs |
| `@mattering/core/recipients` | Sealing to named age X25519 recipients (envelope format 2), opening as a recipient, and disclosing one envelope's file key |
| `@mattering/core/negotiation` | Making sealed offers, and working out a negotiation step, or a whole negotiation, from its evidence |
| `@mattering/core/drand-http` | Fetching drand releases from public relays |
| `@mattering/core/testing` | **Tests only.** A local beacon whose secret you hold, so tests can run the real time lock offline |

## More

- [The protocol](https://github.com/Layer-Loop/mattering/blob/main/docs/protocol.md): every format, written for anyone implementing them.
- [Claims and limits](https://github.com/Layer-Loop/mattering/blob/main/docs/claims.md): what the project claims, what each claim rests on, and what it does not claim.
- [Test vectors](https://github.com/Layer-Loop/mattering/tree/main/test-vectors): known inputs and outputs for a second implementation.
- [Source](https://github.com/Layer-Loop/mattering) and a [live demonstration](https://mattering.ai/demo).

MIT licensed.
