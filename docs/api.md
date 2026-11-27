# The platform API, version 1

Run sealed-bid auctions, negotiations and limit matches from your own systems. Nobody, Mattering included, can read a bid before the agreed time, and every result comes with evidence you can check without trusting Mattering. The design and its assumptions are in [api-design.md](api-design.md); the full description is served at `/api/v1/openapi.json`.

**Demonstration environment.** Proof of concept, not security reviewed. Results are not legally binding and no payment is made or arranged. Every response carries `Mattering-Environment: demonstration`.

Base URL: `https://mattering.ai/api/v1`. JSON in and out. Errors are `{ "error": { "code": "…", "message": "…" } }`.

## Who is calling

| `Authorization` | Who | Can |
| --- | --- | --- |
| `Bearer mk_test_…` | An integrator, by its API key | Create and run sessions, see everything in its own, manage webhooks |
| `Bearer tok_…` | A participant, by the token it got on joining | Bid, check in, disclose, cancel (negotiations), in its own session only |
| none | Anyone | Join with an invitation (`inv_…`), ask what an invitation is for (`GET /sessions/{id}/invitation?code=…`), read a round's policy, and see what a session shows the public |

API keys are issued through Mattering's console, which is invite-only for now; there is no sign-up. Identity stays with you: a participant is its keys and the label you give it.

Send `Idempotency-Key: <anything unique>` on any POST you might retry. The same key with the same request returns the first reply, so a retried bid is not a second bid; with a different request it is refused (`idempotency-mismatch`).

## The SDK

`@mattering/client` does all of the below from your code: it makes and keeps each participant's keys, seals on your machine, retries safely, discloses where its own keys open the bids, and checks every result against the evidence. It refuses to seal under a policy whose beacon it does not accept (drand quicknet unless you say otherwise), that names another session, or that seals bids differently from what the session says.

```ts
import { Mattering } from "@mattering/client";

// The organiser: an invoice-funding desk. Its age key is made here and never sent.
const desk = new Mattering({ apiKey: process.env.MATTERING_KEY });
const session = await desk.sessions.create({
  mechanism: "sealed-bid-auction",
  terms: { item: "Funding of invoice INV-88213", unit: "bps", minBid: 50, maxBid: 1500, rule: "lowest-bid", reserve: 900 },
  invitations: [{ label: "Funder A" }, { label: "Funder B" }],
});
save(session.secrets()); // the desk's age identity: keep it

// Each funder, on its own machine, with only its invitation.
const funder = await new Mattering().join("inv_…");
await funder.next();       // waits for bidding to open
await funder.bid(640);     // sealed here; only the envelope and a signature leave

// The desk's client opens the bids with its own key and publishes the result.
const result = await session.result();
const checked = await session.verify(); // { ok: true, matchesReported: true, outcome: … }
```

For a negotiation, `join(invitation, { limit, organisation: { keys, name } })` issues the agent's mandate locally. Then `next()` and `offer(price)` run round by round, and the client discloses each opened round for you. `secrets()` and `resume()` let a participant or organiser pick a session up again, in another process.

## A reverse auction, client-sealed

The organiser, an invoice-funding desk, creates the session. Under `organiser` confidentiality (the default) the bids are sealed to the desk's own age key, so only the desk can read them.

```bash
curl -s https://mattering.ai/api/v1/sessions \
  -H "authorization: Bearer $MATTERING_KEY" -H "idempotency-key: inv-88213" \
  -d '{
    "mechanism": "sealed-bid-auction",
    "terms": { "item": "Funding of invoice INV-88213", "unit": "bps", "minBid": 50, "maxBid": 1500, "rule": "lowest-bid", "reserve": 900 },
    "timing": { "biddingSeconds": 600 },
    "organiserRecipient": "age1…",
    "invitations": [{ "label": "Funder A" }, { "label": "Funder B" }]
  }'
```

The reply holds the session `id` and an invitation code for each funder. A funder joins with its code and its own Ed25519 public key, and keeps the token:

```bash
curl -s https://mattering.ai/api/v1/join -d '{ "invitation": "inv_…", "publicKey": "…" }'
```

Once two have joined, the organiser opens bidding (`POST /sessions/{id}/open`), or it opens at `timing.opensAt`. Each funder fetches the round's policy (`GET /sessions/{id}/round`), seals its bid on its own machine with `@mattering/core` (`prepareBidTo`), and sends only the envelope and the signed submission:

```bash
curl -s https://mattering.ai/api/v1/sessions/$ID/bids -H "authorization: Bearer $TOKEN" -H "idempotency-key: bid-1" -d @sealed-bid.json
```

When the drand round named in the policy comes, the bids open, to the desk alone. It reads them with its age identity (`verifyAuction` with `bidOpenerAs`), and publishes the result by disclosing the bids' file keys (`discloseBids`), which the engine checks against the evidence:

```bash
curl -s https://mattering.ai/api/v1/sessions/$ID/disclose -H "authorization: Bearer $MATTERING_KEY" -d '{ "fileKeys": { … } }'
curl -s https://mattering.ai/api/v1/sessions/$ID/result -H "authorization: Bearer $MATTERING_KEY"
```

The result gives the outcome, the receipt (with each round's evidence on the public log) and the file keys. Anyone you hand them to can check the result with `verifyAuction` and `bidOpenerWithFileKeys`, or `mattering check-demo`. A funder sees the winner and its own bid; an outsider sees neither.

## Negotiations and limit matches

`"mechanism": "negotiation"` runs rounds between one buyer and one seller (`invitations` with `"role": "buyer"` and `"role": "seller"`): each seals one offer per round; if the buyer's is at least the seller's, the deal is at the midpoint; otherwise the next round, up to `terms.rounds`. `"limit-match"` is one round in which each side seals only its limit.

- Each side joins with its public key, its age recipient and, optionally, its firm's signed mandate (`issueMandate`), whose limit is a commitment.
- Round 1 begins once both are present: the second to join is, by joining; the first says so with `POST /sessions/{id}/check-in`.
- Offers open to the two parties only. After each round, either side discloses its file keys (`discloseStep`), and the engine checks them before going on.
- Either side may walk away with `POST /sessions/{id}/cancel`.

## Server sealing

For callers that cannot run code, such as a chat assistant, `"sealing": "server"` has Mattering hold the participants' keys and seal for them. Bids are then `{ "amount": 640 }`, offers `{ "price": 113500 }`, and a negotiation side joins with its `limit`, which becomes a mandate: offers beyond it are refused (`beyond-mandate`). Mattering could read or forge such bids, and every response says so in `trust`. A server-sealed limit match needs no bids at all.

## Events

`GET /sessions/{id}/events?after=N` lists events as JSON; with `Accept: text/event-stream` the same events come as a stream that resumes from `Last-Event-ID`. The organiser sees every event; a participant sees them without the other participants' names.

Webhooks send an integrator's events as they happen:

```bash
curl -s https://mattering.ai/api/v1/webhooks -H "authorization: Bearer $MATTERING_KEY" -d '{ "url": "https://desk.example/hooks/mattering" }'
```

The reply's `secret` is shown once. Each delivery is a POST of one event, with `Mattering-Signature: t=<unix seconds>,v1=<hex>`, the HMAC-SHA256 of `<t>.<body>` under the secret; `verifyDelivery` in `@mattering/platform/hosted` checks it. A failed delivery is retried with backoff, up to eight times, in order.

Events: `session.created`, `participant.joined`, `round.opened`, `bid.sealed` (who, not how much), `round.closed`, `round.released`, `round.result`, `session.finished`, `session.cancelled`, `session.expired`.

## Your records

With its API key, an integrator can read its own records:

- `GET /sessions`: its sessions, newest first, 50 at a time (`?limit=`, and `?before=` with the `next` value for the next page).
- `GET /webhooks/deliveries`: its recent webhook deliveries, newest first, failed attempts and retries included (`?webhook=` for one webhook).
- `GET /usage`: per day, sessions created, bids sealed, deliveries made and delivery attempts that failed (`?days=`, up to 60). A bid retried with the same `Idempotency-Key` counts once.

## Limits

100 new sessions per integrator per day, 50 participants per session, 10 rounds per negotiation, rounds of 30 seconds to 7 days, 10 webhooks per integrator.
