# Mattering platform API: design

**Status:** draft. Version 1 rests on the [assumptions](#13-assumptions-for-version-1) in section 13; comments are welcome on them and on the [open questions](#14-open-questions-for-review). Being built in order (section 12); auction policy version 4 is the first step.

## 1. What it is

A platform that other companies integrate to run **sealed sessions**: sealed-bid auctions, negotiations and one-shot matches, in which nobody, Mattering included, can read a bid before the agreed time, and everyone involved gets a receipt they can check without trusting Mattering. It is built for software agents bidding on behalf of businesses, and works the same for people.

It comes in three forms over one service:

- **An HTTP API**, specified in OpenAPI, for an integrator's platform and its agents.
- **An SDK**, `@mattering/client`, which seals bids on the bidder's own machine before they are sent.
- **An MCP server** over the same API, for AI assistants such as Claude and ChatGPT.

It does not do, and leaves to others: identity and onboarding, checkout and payments, custody of funds or assets, and settlement. A session ends with a result and a receipt; what happens next is the integrator's.

The first market in mind is business-to-business funding and trading of financial assets: invoices and receivables, private credit, and treasuries, where the auctioneer's neutrality matters and can now be shown rather than promised.

## 2. Concepts

| Term | Meaning |
| --- | --- |
| **Integrator** | A company that uses the API, identified by its API key. It creates sessions and invites participants |
| **Session** | One auction, negotiation or match: its mechanism, terms, participants and timing, from creation to result |
| **Mechanism** | The rules a session runs by (section 3). Each has its own policy format and verifier, and shares everything else |
| **Participant** | A party to a session, with a role: *bidder* in an auction, *buyer* or *seller* in a negotiation or match. Each holds its own Ed25519 signing key and, where offers are sealed to recipients, an age X25519 key |
| **Organiser** | The party that runs the session for its own purposes: in a reverse auction for funding, the platform or the invoice's seller. May also be a recipient of the bids |
| **Sealed bid** | A bid (or offer, or limit) locked to the session's release round, and optionally to named recipients, and signed by its participant |
| **Round** | One sealed exchange. An auction has one; a negotiation up to several |
| **Receipt** | What a participant gets for each sealed bid (its place in the log, signed), and what everyone gets at the end (each round's policy, the drand round that opened it, and where its evidence is) |
| **Evidence** | Everything needed to work the result out again without Mattering: the policy, the log entries, the closing checkpoint, its cosignatures, the envelopes and the drand signature ([protocol.md](protocol.md)) |

## 3. Mechanisms, version 1

Every mechanism follows the same pattern: participants seal before the round closes; the log is closed, signed and cosigned while everything is still sealed; drand releases the key; the result follows from the evidence alone.

### 3.1 Sealed-bid auction

| | |
| --- | --- |
| **Who** | One organiser, two or more bidders |
| **Bids** | One per bidder, a whole number in the session's unit, within `[minBid, maxBid]`, with a Pedersen commitment to it |
| **Rule** | `highest-bid` (selling) or `lowest-bid` (buying, funding, procurement). First price: the winner's bid is the price. Optional `reserve`: no winner unless the best bid reaches it |
| **Ties** | Broken by the release round's signature, as today: unpredictable before release, and the same for everyone after |
| **Confidentiality** | `public` (bids open to everyone at release, as in today's auction), or `organiser` (bids sealed to the organiser's and each bidder's own recipient keys; outsiders see only that each bid was in on time, and the result is checkable by anyone the organiser discloses to) |
| **Example** | A receivables funding desk: an invoice of £250,000 due in 90 days; funders bid the discount in basis points; lowest wins |

New compared with today: `lowest-bid`, `reserve`, and `organiser` confidentiality, in auction policy version 4 ([protocol.md](protocol.md), section 7.1).

### 3.2 Negotiation in rounds

As built for the Negotiation Room and the MCP tables: one buyer and one seller, each under a mandate with a committed limit; each round both seal one offer, sealed to both; if the buyer's offer is at least the seller's, the deal is at the midpoint; otherwise the next round, up to the agreed number. No change to the format ([protocol.md](protocol.md), sections 9 and 10).

### 3.3 Limit match

One round, in which each side seals only its limit: the buyer's most and the seller's least. If they overlap, the deal is at the midpoint; otherwise there is no deal and neither learns the other's limit beyond that. There is nothing to haggle over, so the result depends on the limits the parties set and not on which agent bargains better. It is a negotiation with `rounds: 1` whose offers are the mandates' limits, so it needs no new format; the API names it separately because integrators will choose it for that reason.

## 4. Trust model

The point of the platform is that the operator cannot cheat, so the API is explicit about what each party has to trust.

| Mode | Who seals | What Mattering can see | Use |
| --- | --- | --- | --- |
| **Client-sealed** (default) | The participant, with the SDK, on its own machine | Only sealed envelopes, signed by the participant. It cannot read a bid before release, nor make one in a participant's name | Integrations, agents running code |
| **Server-sealed** | Mattering, with keys it holds for the participant | Every bid and limit, before sealing. It could read or forge them | Chat assistants that cannot run code (MCP); demonstrations. Labelled as such in every response and on every receipt |

In both modes, Mattering cannot open a bid before drand releases the round, cannot rewrite or reorder the log after the close without the cosigners' signatures showing it, and cannot change a result that anyone can recompute. What remains trusted is listed in [threat-model.md](threat-model.md): drand's threshold, at least one honest cosigner (public witnesses once they cosign the log), and Mattering accepting every submission it receives. A refused submission is the participant's to prove with its signed request; the receipt shows an accepted one.

## 5. Lifecycle and timing

```
created ──► open ──► closed ──► released ──► finished
   │          │                                  ▲
   └──────────┴──── cancelled                    │
                     expired (no quorum) ────────┘ (no result)
```

- **created:** terms fixed, invitations out. Participants join and register their keys.
- **open:** the first round's policy is registered on the log; bids are accepted until the close. A session opens at `opensAt`, or when the organiser opens it, or (negotiations) once both sides have checked in. It needs a quorum: at least two bidders, or both sides.
- **closed:** at the close round the log is closed, signed and sent to the cosigners. No bid is accepted after it.
- **released:** drand publishes the release round, a few rounds later; anyone can open the bids that are theirs to open and work out the result.
- **finished:** the result and the final receipt are fixed. A negotiation goes from released back to open for its next round until it ends.
- **cancelled / expired:** before the first close, the organiser may cancel; a session without a quorum by its deadline expires. Either way there is no result, and any bids already sealed stay sealed.

Times are given as wall-clock instants and as drand rounds. The round is authoritative; the instant is what it will be, to within a round.

## 6. HTTP API

Base URL: `https://api.mattering.ai/v1` (in the proof of concept, `https://mattering.ai/api/v1`). JSON in and out. Every response carries `environment` (`demonstration` until there is anything else) and whether the session is client- or server-sealed.

### 6.1 Authentication

- **Integrator:** `Authorization: Bearer mk_live_…` or `mk_test_…`, an API key. Creates and manages its sessions and receives their events.
- **Participant:** `Authorization: Bearer tok_…`, a token issued when it joins, valid for that session only. An integrator may also act for its own participants with its API key.
- **Every bid is also signed** with the participant's Ed25519 key, so a token alone cannot make a bid in a client-sealed session.
- Invitations are codes (`inv_…`) for sharing; they let one party join once.

### 6.2 Endpoints

| Request | Does |
| --- | --- |
| `POST /sessions` | Create a session: mechanism, terms, timing, confidentiality, sealing mode, invitations. Returns the session and its invitation codes |
| `GET /sessions/{id}` | The session as the caller may see it: terms, state, rounds, timing, what is sealed and by whom, the result once finished |
| `POST /sessions/{id}/join` | Join with an invitation: role, public signing key, recipient key, and for negotiations the mandate. Returns a participant token |
| `GET /sessions/{id}/round` | The current round's policy, which a client-sealed bid must be sealed under |
| `POST /sessions/{id}/bids` | Submit a bid: client-sealed `{ submission, envelope }`, or server-sealed `{ amount }`. Returns the receipt. One per participant per round |
| `POST /sessions/{id}/check-in` | A participant is present (negotiations: round 1 waits for both) |
| `POST /sessions/{id}/open` | Organiser: open now instead of at `opensAt` |
| `POST /sessions/{id}/cancel` | Organiser before the first close, or either side of a negotiation (walking away) |
| `GET /sessions/{id}/result` | The outcome, the final receipt, and the disclosure needed to check it (for `organiser` confidentiality, to callers the organiser has allowed) |
| `GET /sessions/{id}/evidence` | Every round's evidence, as the public log serves it, in one bundle; the format `mattering check-demo` reads today, generalised |
| `GET /sessions/{id}/events` | A stream (server-sent events) of the session's events, for callers that would rather not poll |
| `POST /webhooks` · `GET` · `DELETE /webhooks/{id}` | Integrator: where to send events |

The public log stays where it is (`https://mattering.ai/log/…`), read-only, for anyone.

### 6.3 Creating a session: a reverse auction

```json
POST /v1/sessions
{
  "mechanism": "sealed-bid-auction",
  "terms": {
    "item": "Funding of invoice INV-88213: £250,000, due 2027-03-01",
    "unit": "bps",
    "minBid": 50,
    "maxBid": 1500,
    "rule": "lowest-bid",
    "reserve": 900
  },
  "timing": { "opensAt": "2026-12-01T10:00:00Z", "biddingSeconds": 600, "quorumBy": "2026-12-01T10:05:00Z" },
  "confidentiality": "organiser",
  "sealing": "client",
  "invitations": [{ "role": "bidder", "label": "Funder A" }, { "role": "bidder", "label": "Funder B" }, { "role": "bidder", "label": "Funder C" }]
}
```

```json
201 Created
{
  "id": "ses_7f3a…",
  "environment": "demonstration",
  "state": "created",
  "invitations": [{ "label": "Funder A", "code": "inv_…" }, …],
  "watchUrl": "https://mattering.ai/demo/session?id=ses_7f3a…"
}
```

### 6.4 A client-sealed bid

The SDK fetches the round's policy, seals the amount to the release round (and to the recipients the policy names), commits to it, signs the submission with the bidder's key and sends `{ submission, envelope }`. Nothing in the request reveals the amount.

```json
201 Created
{
  "round": 1,
  "receipt": { "format": "mattering.receipt/1", "witness": "…", "index": 48213017, "size": 48213018, "root": "…", "proof": ["…"], "signature": "…" },
  "closesAt": "2026-12-01T10:10:00Z", "closeRound": 35768000,
  "opensAt": "2026-12-01T10:10:09Z", "releaseRound": 35768003
}
```

### 6.5 The result

```json
{
  "state": "finished",
  "outcome": { "winner": "par_…", "label": "Funder B", "price": 640, "unit": "bps" },
  "receipt": {
    "sessionId": "ses_7f3a…",
    "log": { "origin": "mattering.ai/log", "witness": "…", "cosigners": ["…"] },
    "rounds": [{ "round": 1, "policyHash": "…", "closeRound": 35768000, "releaseRound": 35768003, "evidence": "https://mattering.ai/log/policies/…/evidence" }]
  },
  "disclosure": { "fileKeys": { "…": "…" } }
}
```

The integrator's own systems take the outcome from here: settlement, payment, contracts.

### 6.6 Errors, idempotency, limits

- Errors are `{ "error": { "code": "late", "message": "round 1 closed at …" } }`, with codes such as `late`, `duplicate`, `out-of-range`, `beyond-mandate`, `not-a-participant`, `no-quorum`.
- `Idempotency-Key` on every POST, so a retried bid is not a second bid.
- Limits per integrator key: sessions per day, participants per session, bids per round.
- The API is versioned in the path; the formats on the log are versioned in their `format` fields and never change in place.

## 7. Events

Delivered by webhook (signed with the integrator's webhook secret) and on the session's event stream:

`session.created`, `participant.joined`, `session.opened`, `bid.sealed` (who, not how much), `round.closed`, `round.cosigned`, `round.released`, `round.result`, `session.finished`, `session.cancelled`, `session.expired`.

## 8. The SDK

```ts
import { Mattering } from "@mattering/client";

const mattering = new Mattering({ apiKey: process.env.MATTERING_KEY });
const session = await mattering.sessions.join("inv_…", { role: "bidder" }); // makes and keeps the bidder's keys
await session.bid(640);                     // sealed here; only the envelope leaves this machine
const result = await session.result();      // waits for the release
const checked = await mattering.verify(result); // recomputes the outcome from the evidence, trusting no one
```

The SDK builds on `@mattering/core`, which does the sealing and the verifying; `mattering.verify` runs the same verifiers as the watch page and `mattering check-demo`.

## 9. The MCP server

The tools become a thin layer over the API, keeping what works today (asking the user for every setting, `wait_for_next_round`, approval per offer, `tok_`/`inv_`, the receipt) and adding auctions: `start_auction`, `join_auction`, `place_bid`, alongside the negotiation tools. Through a chat assistant that cannot run code, sessions are server-sealed, and say so.

## 10. What is reused, and what is new

| Part | State |
| --- | --- |
| Sealing, opening, recipients, commitments, mandates, verifiers (`@mattering/core`) | Built. Auction policy version 4 (lowest bid, reserve, bids sealed to recipients) is the first step |
| Witness log, receipts, cosigning, public read-only log | Built, unchanged |
| Negotiation rounds, check-in, approval per offer, receipts | Built in the MCP tables; to be moved into the session engine |
| Session engine (one engine, mechanisms as plug-ins) | New: unifies today's auction room, negotiation room and tables |
| HTTP API v1, API keys, webhooks, event stream, OpenAPI spec | New |
| `@mattering/client` | New |
| MCP over the API, with auctions | Rework |
| Demo: a receivables funding desk, built only on the public API | New, as a separate app |

## 11. Not in version 1

Identity and onboarding, payments and checkout, custody, on-chain settlement (see [research-questions.md](research-questions.md) for verifying evidence on Ethereum), second-price and multi-unit auctions, early close of a round once every participant has sealed, billing.

## 12. Order of work

1. This design, reviewed.
2. The session engine, with the reverse sealed auction beside negotiation, and the core's new auction rule.
3. The HTTP API on the Worker, with API keys, and `@mattering/client` sealing locally.
4. The MCP server rebuilt on the API.
5. The receivables funding desk demo and a quickstart.

## 13. Assumptions for version 1

There is no design partner in this market yet to answer the questions below, so version 1 is built on these assumptions. Each can be changed later without changing what is already on the log.

1. **Losing bids** are seen by the organiser after release; bidders see the result and their own bid. Confidentiality is `organiser` by default, `public` on request.
2. **Amounts** are whole numbers in a unit the integrator names (`bps`, `GBP`); the API does not convert.
3. **The reserve** is public, in the policy.
4. **One winner** per auction. Splitting an amount between several winners is later.
5. **Participants** are their keys and the integrator's label for them. Identity stays with the integrator.
6. **The hand-off** is the result, the receipt and the evidence; nothing signed beyond them in version 1.
7. **Timing** is fixed windows. Closing early once everyone has sealed is later, after review.
8. **Hosting** is the hosted service first; running it yourself remains possible, as all of it is open.

## 14. Open questions for review

1. **Who reads the losing bids?** With `organiser` confidentiality, the organiser sees every bid after release. Should bidders see the others' bids, or only the result and their own rank?
2. **Price or rate?** Should funding auctions be bid as a discount in basis points, an advance rate, or a price, and should the API convert between them?
3. **Reserve visibility.** Is the reserve public, or committed and disclosed after release, like a mandate's limit?
4. **Several winners.** Receivables are often split between funders. Is one winner enough for a first version, or is a multi-unit auction (fill the amount from the lowest bids up) needed early?
5. **Who is a participant?** Version 1 identifies participants only by their keys and the integrator's label. What would an integrator need before relying on that, short of building identity?
6. **Hand-off.** What does an integrator need in the result to settle: a signed statement of the outcome, a standard message format, or the evidence alone?
7. **Timing.** Are fixed bidding windows acceptable, or is closing early once every invited bidder has sealed important enough to take through review?
8. **Hosting.** Would an integrator use a hosted service from day one, or need to run it themselves first?

Proof of concept, not security reviewed. See [claims.md](claims.md) for what is claimed and what is not.
