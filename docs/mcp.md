# Mattering as an MCP server

Mattering offers its sealed negotiation to AI assistants through the [Model Context Protocol](https://modelcontextprotocol.io). Two people, or one person with two different assistants, connect their assistants to Mattering, and each negotiates for one side at a **table**. For example, Claude might act for the buyer and ChatGPT for the seller. Each round, both offers are sealed until a public clock opens them together; neither assistant can see the other's offer before making its own.

**Status:** proof of concept, not security reviewed. In this version Mattering's server holds both parties' keys and seals their offers for them, as in the [Negotiation Room](negotiation-room.md). In practice each party would seal on its own machine, so that no one else ever holds its keys.

## Environments

Every tool description, the server's instructions, and every reply say which environment the server is, so that neither an assistant nor its user can mistake a demonstration for a real transaction. Each reply starts with the line, and carries the same facts as data under `environment`:

| Field | In the demonstration |
| --- | --- |
| `name` | `demonstration` |
| `legallyBinding` | `false`: an offer commits no one to anything |
| `paymentsMade` | `false`: no payment is made or arranged |
| `offers` | Sealed and time-locked for real, and recorded on Mattering's public log |
| `organisations` | Whoever the parties name; not verified |
| `keys` | Mattering's server holds both parties' keys and seals offers for them |
| `clock` | drand quicknet on mattering.ai; simulated only in development |

Only the demonstration exists. A live environment, if there is one, will be a separate server address with its own terms, and will say so in the same fields. Assistants may still be cautious: in the first runs, ChatGPT's own checks blocked one offer, and Claude reported a note "blocked before sending"; neither came from Mattering, which refuses only offers beyond a limit, a second offer in a round, or an offer after the round's window.

The tools are also marked as acting only on Mattering's own tables (`openWorldHint: false`), and none of them as destructive.

## Connecting an assistant

The server is at `https://mattering.ai/mcp`. It uses MCP's Streamable HTTP transport, needs no sign-in, and offers five tools.

- **Claude** (claude.ai, the Claude apps, Claude Code): add a custom connector with that URL. In Claude Code: `claude mcp add --transport http mattering https://mattering.ai/mcp`.
- **ChatGPT**: in a plan and mode that allow custom connectors to MCP servers, add a connector with that URL and no authentication.
- **Any MCP client** that speaks Streamable HTTP works the same way.

Assistants keep the list of tools they were given when the connector was added, and a chat keeps the list it started with. When the tools change, refresh or re-add the connector, and start a new chat.

On a laptop, `npm run showcase` serves the same endpoint at `http://127.0.0.1:8790/mcp`, for clients on the same machine; it refuses requests that a web page on any other site makes through the browser.

## The tools

| Tool | What it does |
| --- | --- |
| `start_negotiation` | Opens a table. The user decides, and the assistant must ask: what is negotiated, the lowest and highest price, their own limit, how long each round stays open (20 to 600 seconds), and whether the assistant bids autonomously or asks them to approve each offer. Optional: the unit, the organisation's name, and how many rounds (1 to 5, default 3). Returns a token for the caller and an invite code for the other side |
| `join_negotiation` | Takes the other side with the invite code. The user decides, and the assistant must ask: their own limit, and whether it bids autonomously. The reply gives the terms, for the assistant to read back to the user. Round 1 begins at once |
| `negotiation_status` | Everything the caller's side may know: the terms, its own limit, the current round and its timing, whether each side has sealed, every opened round's two offers, and the result |
| `wait_for_next_round` | Holds the call until the table moves on (the other side joins, the round opens, the next begins, or the negotiation ends), for at most 40 seconds by default and 55 at most, then says what changed. Returns at once if the caller still owes an offer for an open round |
| `make_offer` | Seals the caller's offer for the current round, with an optional note to its own organisation. If the user chose to approve each offer, it must carry `approvedByUser: true`, given only once the user has approved that exact price. Only the first offer in a round counts. An offer beyond the caller's own limit is refused |

MCP gives a server no way to tell an assistant that something has happened, so every reply carries a `nextStep`, and the tools' descriptions tell an assistant to keep calling `wait_for_next_round` after each offer until the negotiation is finished. With that, one request such as "negotiate this for us" is enough for an assistant to run the whole negotiation without being prompted round by round. In the first run with real assistants, before this tool existed, Claude kept checking by itself and ChatGPT waited to be asked.

A conversation goes like this. Tell your assistant something like "open a Mattering negotiation to sell early payment of a £10,000 invoice, between £9,000 and £10,000; we accept no less than £9,600", and pass the invite it returns to the other side. Then ask each assistant, round by round, to make its offer, and to check the status once the round opens.

## Asking the user

The settings that are the user's to decide are required, and every description tells the assistant to ask for them and never to choose them itself. If an assistant calls without them, the server opens nothing and replies with what to ask: "Not yet: ask your user for how long each round should stay open; and whether you should bid autonomously or ask them to approve each offer, then call start_negotiation again."

Each side chooses how its assistant bids:

- **Autonomously:** the assistant makes every offer itself, waits for each round, and reports at the end.
- **With approval:** each round's `nextStep` tells the assistant to propose an offer and ask the user to approve that exact price. `make_offer` refuses an offer without `approvedByUser: true` and says what to ask. The server cannot see the conversation, so this rests on the assistant telling the truth; what it guarantees is that an assistant which has not been told to ask is sent back to ask. Allow longer rounds, three minutes or more, so the user has time to answer.

## How a table runs

- Each party's limit becomes its organisation's mandate, committed so the other side cannot read it ([protocol.md](protocol.md), section 10).
- Each round is a step of a sealed negotiation on the shared log, with a fixed window. Offers are sealed to both parties and to the round's release, a few drand rounds after the window closes. The log closes and is cosigned before they open.
- If the buyer's offer is at least the seller's, the deal is at the midpoint. Otherwise the next round begins, up to the agreed number. A side that misses a round's window makes no offer in it, and that round ends without a deal.
- Rounds have fixed windows rather than closing as soon as both sides have sealed. An early close would change when a round's offers open after they were sealed, which needs more design and review.

## Watching a table

Every tool reply carries a watch link, `https://mattering.ai/demo/table?id=<table>`. The page shows the negotiation as a conversation, round by round, and once it ends works every round out in the browser from the evidence and the two parties' disclosures, as the Negotiation Room does. Anyone with the link sees each round's offers, notes and both limits once the round opens.

## Tokens and invites

A token acts for one side, and an invite lets one party join; each starts with the table's id. They are random and unguessable, but they pass through the assistants' conversations, so anyone who can read those conversations can act for that side. Keep them as you would a password for a demonstration account.

## Limits

On mattering.ai, tables open at most `TABLES_PER_DAY` times a day across everyone (default 100), and a table is deleted a day after anyone last acted at it.

## Not covered by automated tests

`tests/mcp.test.ts`, which also covers waiting for a round to open and the end of the negotiation, drives two tables through the laptop server with the official MCP TypeScript client: two assistants open and join, an offer beyond a limit and a second offer in a round are refused, the rounds run to a deal, and the result is worked out again from the evidence. It also checks the endpoint's answers to other methods and other origins. The Cloudflare version was run by hand in Cloudflare's local runtime with the simulated clock on 2026-11-26, driven by the same client, and the watch page reached the deal with every check passing. On 2026-11-26 the deployed server was used from Claude and ChatGPT, against live drand: three rounds ran and ended without a deal, as the offers had not crossed. Waiting was then added, and checked in Cloudflare's local runtime (one wait held for 35 seconds and returned as the round opened); it has not yet been tried from Claude or ChatGPT.
