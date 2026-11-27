# Mattering as an MCP server

Mattering offers its sealed negotiations and sealed-bid auctions to AI assistants through the [Model Context Protocol](https://modelcontextprotocol.io).

- **A negotiation table:** two people, or one person with two different assistants, connect their assistants to Mattering, and each negotiates for one side. For example, Claude might act for the buyer and ChatGPT for the seller. Each round, both offers are sealed until a public clock opens them together; neither assistant can see the other's offer before making its own.
- **An auction:** one assistant runs it for its user, the organiser, and invites two to ten bidders' assistants. Each seals one bid; nobody, the organiser included, can read any bid until bidding closes and the public clock opens them together.

Each table and auction is a session on Mattering's platform ([api.md](api.md)), which this server uses as an integrator would. The tools add what is particular to an assistant acting for a person: asking the user for every setting, the user's approval of each offer, the user's own limit, and replies an assistant can act on.

**Status:** proof of concept, not security reviewed. An assistant in a chat cannot run code, so the sessions are server-sealed: Mattering's server holds every party's keys and seals offers and bids for them, and every reply says so. Through the platform's SDK, `@mattering/client`, each party seals on its own machine instead, so that no one else ever holds its keys.

## Environments

Every tool description, the server's instructions, and every reply say which environment the server is, so that neither an assistant nor its user can mistake a demonstration for a real transaction. Each reply starts with the line, and carries the same facts as data under `environment`:

| Field | In the demonstration |
| --- | --- |
| `name` | `demonstration` |
| `legallyBinding` | `false`: an offer commits no one to anything |
| `paymentsMade` | `false`: no payment is made or arranged |
| `offers` | Sealed and time-locked for real, and recorded on Mattering's public log |
| `organisations` | Whoever the parties name; not verified |
| `keys` | Mattering's server holds every party's keys and seals offers and bids for them |
| `clock` | drand quicknet on mattering.ai; simulated only in development |

Only the demonstration exists. A live environment, if there is one, will be a separate server address with its own terms, and will say so in the same fields. Assistants may still be cautious: in the first runs, ChatGPT's own checks blocked one offer, and Claude reported a note "blocked before sending"; neither came from Mattering, which refuses only offers beyond a limit, a second offer in a round, or an offer after the round's window.

The tools are also marked as acting only on Mattering's own sessions (`openWorldHint: false`). Only `leave_negotiation` is marked as destructive, as it ends the negotiation for both sides.

## Connecting an assistant

The server is at `https://mattering.ai/mcp`. It uses MCP's Streamable HTTP transport, needs no sign-in, and offers eleven tools: six for negotiations between one buyer and one seller, and five for auctions with two to ten bidders.

- **Claude** (claude.ai, the Claude apps, Claude Code): add a custom connector with that URL. In Claude Code: `claude mcp add --transport http mattering https://mattering.ai/mcp`.
- **ChatGPT**: in a plan and mode that allow custom connectors to MCP servers, add a connector with that URL and no authentication.
- **Any MCP client** that speaks Streamable HTTP works the same way.

Assistants keep the list of tools they were given when the connector was added, and a chat keeps the list it started with. When the tools change, refresh or re-add the connector, and start a new chat.

On a laptop, `npm run showcase` serves the same endpoint at `http://127.0.0.1:8790/mcp`, for clients on the same machine; it refuses requests that a web page on any other site makes through the browser.

## The tools

| Tool | What it does |
| --- | --- |
| `start_negotiation` | Opens a table. The user decides, and the assistant must ask: what is negotiated, the lowest and highest price, their own limit, how many rounds (1 to 5), how long each round stays open (30 to 600 seconds), and whether the assistant bids autonomously or asks them to approve each offer. Optional: the unit and the organisation's name; the reply names any default it used, for the assistant to tell the user. Returns a token (`tok_…`, secret) and an invite (`inv_…`) for the other side. The description and the reply state the rules: two parties, midpoint if the offers cross, no deal after the last round |
| `join_negotiation` | Takes the other side with the invite. The user decides, and the assistant must ask: their own limit, and whether it bids autonomously. The reply gives the terms and the rules, for the assistant to read back to the user |
| `wait_for_next_round` | Holds the call until the table moves on (the other side joins or checks in, a round begins or opens, or the negotiation ends), for at most 40 seconds by default and 55 at most, then says what changed and what to do next. Returns at once if the caller owes an offer for an open round. Calling it checks the caller in |
| `make_offer` | Seals the caller's offer for the current round, with an optional note to its own organisation. If the user chose to approve each offer, it must carry `approvedByUser: true`, given only once the user has approved that exact price. Only the first offer in a round counts. An offer beyond the caller's own limit is refused |
| `negotiation_status` | Where the table stands, without waiting: the same as `wait_for_next_round` returns. Calling it checks the caller in |
| `leave_negotiation` | Ends the negotiation for both sides, with no deal, when the user asks to walk away. The other side is told when it next waits or checks |
| `start_auction` | Sets up an auction, its caller as the organiser, who does not bid. The user decides, and the assistant must ask: what is auctioned, the lowest and highest bid, whether the highest or the lowest bid wins, how many bidders (2 to 10) and how long bidding stays open; optionally a public reserve. Returns a token and one invite per bidder |
| `join_auction` | Joins as a bidder with an invite. The user decides: their own limit (where the highest bid wins, the most they will bid; where the lowest wins, the least), and whether the assistant bids autonomously. Bidding opens by itself once every invited bidder has joined |
| `place_bid` | Seals the bidder's one bid while bidding is open. A bid beyond the user's limit is refused; with approval, it needs `approvedByUser: true` |
| `open_auction` | For the organiser: opens bidding without waiting for every invited bidder, once at least two have joined |
| `auction_status` | Where the auction stands, without waiting. `wait_for_next_round` serves auctions too |

Only opening and joining return the full environment and the terms; later replies are short, starting with the demonstration line and the next step.

MCP gives a server no way to tell an assistant that something has happened, so every reply carries a `nextStep`, and the tools' descriptions tell an assistant to keep calling `wait_for_next_round` after each offer until the negotiation is finished. With that, one request such as "negotiate this for us" is enough for an assistant to run the whole negotiation without being prompted round by round. In the first run with real assistants, before this tool existed, Claude kept checking by itself and ChatGPT waited to be asked.

A conversation goes like this. Tell your assistant something like "open a Mattering negotiation to sell early payment of a £10,000 invoice, between £9,000 and £10,000; we accept no less than £9,600", and pass the invite it returns to the other side. Then ask each assistant, round by round, to make its offer, and to check the status once the round opens.

## Asking the user

The settings that are the user's to decide are required, and every description tells the assistant to ask for them and never to choose them itself. If an assistant calls without them, the server opens nothing and replies with what to ask: "Not yet: ask your user for how many rounds at most; how long each round should stay open; and whether you should bid autonomously or ask them to approve each offer, then call start_negotiation again."

Each side chooses how its assistant bids:

- **Autonomously:** the assistant makes every offer itself, waits for each round, and reports at the end.
- **With approval:** each round's `nextStep` tells the assistant to propose an offer and ask the user to approve that exact price. `make_offer` refuses an offer without `approvedByUser: true` and says what to ask. The server cannot see the conversation, so this rests on the assistant telling the truth; what it guarantees is that an assistant which has not been told to ask is sent back to ask. Allow longer rounds, three minutes or more, so the user has time to answer.

## How a table runs

- Each party's limit becomes its organisation's mandate, committed so the other side cannot read it ([protocol.md](protocol.md), section 10).
- Round 1 begins only once both sides have checked in after the second has joined: joining checks the joiner in, and the opener's next wait or status call checks it in. An opener that has stopped watching loses no rounds while it is away. A table nobody joins within 30 minutes expires.
- Each round is a step of a sealed negotiation on the shared log, with a fixed window. Offers are sealed to both parties and to the round's release, a few drand rounds after the window closes. The log closes and is cosigned before they open.
- If the buyer's offer is at least the seller's, the deal is at the midpoint. Otherwise the next round begins, up to the agreed number. A side that misses a round's window makes no offer in it, and that round ends without a deal.
- Rounds have fixed windows rather than closing as soon as both sides have sealed. An early close would change when a round's offers open after they were sealed, which needs more design and review. So would sealing a conditional offer for a later round in advance, as each round's terms exist only once the round before has opened.

## How an auction runs

- The organiser's assistant sets the terms and hands one invite to each bidder's assistant. Bidders may name themselves on joining; otherwise they are numbered.
- Bidding opens once every invited bidder has joined, or when the organiser opens it with at least two. An auction fewer than two join within 30 minutes expires.
- Each bid is sealed to the organiser and to the release, a few drand rounds after bidding closes. Then the best bid wins: the highest, or the lowest where the organiser is buying (funding, procurement). With a reserve, there is no winner unless the best bid reaches it.
- The organiser's assistant sees every bid; each bidder's sees the winner and its own bid.

## The receipt

When a negotiation or an auction ends, the reply carries a receipt: the session's id, the log's origin, witness and cosigners, and for each round its policy hash, the drand round that opened it, where its offers sit in the log, and the address of its evidence (`https://mattering.ai/log/policies/<hash>/evidence`). Anyone can check every round in the browser at the watch link, or download the evidence there and check it offline with `mattering check-demo`.

## Watching a table

Every tool reply carries a watch link, `https://mattering.ai/demo/table?id=<table>`. The page shows the negotiation as a conversation, round by round, and once it ends works every round out in the browser from the evidence and the two parties' disclosures, as the Negotiation Room does. Anyone with the link, the other side included, sees each round's offers once the round opens. Both limits are disclosed only once the negotiation has ended: tables before the platform disclosed them with each opened round, which told each side the other's limit after round 1. Notes are likewise held back until the negotiation is over, as a note can give away a side's strategy, and every tool that takes a note says so. Auctions have no watch page yet: their result and receipt come in the replies.

## Tokens and invites

A token (`tok_…`) acts for one side and is secret; an invite (`inv_…`) is for sharing with the other party, and lets it join once. Passing one where the other belongs is refused with a message saying which is which. Tying a token to an assistant's session is not practical, as assistants do not reliably keep one MCP session for a conversation. Both are random and unguessable, but they pass through the assistants' conversations, so anyone who can read those conversations can act for that side. Keep them as you would a password for a demonstration account.

## Limits

On mattering.ai, tables and auctions together open at most `TABLES_PER_DAY` times a day across everyone (default 100). One that not enough parties join expires after 30 minutes, and each is deleted 30 days after anyone last acted on it. Tables opened before they became platform sessions keep their watch pages, but their tokens no longer work with the tools.

## Not covered by automated tests

`tests/mcp.test.ts` also runs an auction: an organiser's assistant and three funders' assistants, a bid beyond a limit and a second bid refused, a bid waiting for approval, and the result worked out again from the evidence and the disclosed keys. On 2026-11-27 the rebuilt server was run in Cloudflare's local runtime with the simulated clock: a negotiation and an auction ran to their results through the tools, and the watch page reached the negotiation's deal with every check passing. After the deploy that day, Claude and ChatGPT were offered the auction tools once their connectors were refreshed, and Claude asked its user for the auction's settings as the tools require; a full auction between assistants has not yet been reported.

Before the rebuild:

`tests/mcp.test.ts`, which also covers waiting for a round to open and the end of the negotiation, drives two tables through the laptop server with the official MCP TypeScript client: two assistants open and join, an offer beyond a limit and a second offer in a round are refused, the rounds run to a deal, and the result is worked out again from the evidence. It also checks the endpoint's answers to other methods and other origins. The Cloudflare version was run by hand in Cloudflare's local runtime with the simulated clock on 2026-11-26, driven by the same client, and the watch page reached the deal with every check passing. On 2026-11-26 the deployed server was used from Claude and ChatGPT, against live drand: three rounds ran and ended without a deal, as the offers had not crossed. Waiting was then added, and checked in Cloudflare's local runtime (one wait held for 35 seconds and returned as the round opened); it has not yet been tried from Claude or ChatGPT.
