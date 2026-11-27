/**
 * Mattering as an MCP server: tools that let an AI assistant (Claude,
 * ChatGPT, or any MCP client) run a sealed negotiation or a sealed-bid
 * auction for its user. Served over MCP's Streamable HTTP transport,
 * answering each POST with plain JSON: no sessions, no streams.
 *
 * The tools are a thin layer over the platform's sessions (docs/api-design.md,
 * section 9): this server is an integrator of the platform, and each table or
 * auction is a server-sealed session. What is particular to an assistant
 * acting for a person stays here: asking the user for every setting, the
 * user's approval of each offer, the user's own limit on bids, and replies an
 * assistant can act on. Each call is routed by the session id at the front of
 * the token or invite, so the same code runs on a laptop and on Cloudflare.
 */
import type { Reply } from "@mattering/witness/routes";
import { sha256, type SessionCall } from "../../platform/src/hosted.ts";
import { newSessionId, sessionOf, type Caller } from "../../platform/src/session.ts";

/** Where sessions live, as this server reaches them: in this process on a laptop, Durable Objects on Cloudflare. */
export interface McpBackend {
  session(id: string): { call(req: SessionCall): Promise<Reply> };
  /** The platform integrator this server acts as. */
  integrator: string;
  /** Draws on the day's allowance of new tables and auctions; false once it is spent. */
  allow(): Promise<boolean>;
  /** Where anyone can watch a negotiation. */
  watchUrl(sessionId: string): string;
  /** Where anyone can fetch a round's evidence from the shared log. */
  evidenceUrl(policyHash: string): string;
  /** The clock sessions run on: drand in public, simulated only for development. */
  clock: "live" | "simulated";
}

export const MCP_LIMITS = {
  minRounds: 1,
  maxRounds: 5,
  minRoundSeconds: 30,
  /** Long enough for an assistant to read the status, decide and seal; short enough for a demonstration. */
  defaultRoundSeconds: 60,
  maxRoundSeconds: 600,
  minBidders: 2,
  maxBidders: 10,
  maxBiddingSeconds: 3600,
  maxNote: 280,
  /** A table or auction that not enough parties join expires this long after it was opened. */
  joinWithinMs: 30 * 60 * 1000,
} as const;

/**
 * What kind of environment this server is, said in every tool description and
 * reply, so that neither the assistant nor its user can mistake a
 * demonstration for a real transaction. Only a demonstration exists. A live
 * environment would be a separate server, at its own address, with its own
 * terms, and would say so here in the same words.
 */
export function environment(clock: "live" | "simulated") {
  return {
    name: "demonstration",
    legallyBinding: false,
    paymentsMade: false,
    offers: "Sealed and time-locked for real, and recorded on Mattering's public log, but they commit no one to anything.",
    organisations: "Whoever the parties name. Not verified.",
    keys: "Mattering's server holds every party's keys and seals offers and bids for them. Through Mattering's platform SDK each party would seal on its own machine.",
    clock: clock === "live" ? "drand quicknet, the public randomness beacon" : "simulated on the server, for development only",
    liveEnvironment: "None exists yet. A live environment would be a separate server address with its own terms.",
  };
}
/** The one line every description and reply starts with. */
const DEMONSTRATION = "Demonstration environment: offers are sealed and recorded for real, but they are not legally binding and no payment is made or arranged.";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "mattering", title: "Mattering sealed negotiations and auctions", version: "0.3.0" };

/** The rules of a table, said where an assistant reads them before it opens or joins one. */
const RULES =
  "A negotiation has two parties only, one buyer and one seller. " +
  "Each round, both sides seal one offer and the two open together. If the buyer's offer is at least the seller's, the deal is at the midpoint of the two; otherwise the next round begins, up to the agreed number of rounds, after which there is no deal.";
const AUCTION_RULES =
  "A sealed-bid auction has one organiser, who does not bid, and two or more bidders. " +
  "Each bidder seals one bid; nobody, the organiser included, can read any bid until bidding closes and a public clock (drand) releases them. Then the best bid wins: the highest, or the lowest where the organiser is buying (funding, procurement). With a reserve, there is no winner unless the best bid reaches it. The organiser sees every bid; each bidder sees the winning bid and its own.";
/** Who reads the notes, said wherever a note can be written. */
const NOTES = "Notes are shown on the watch page, which both sides have, once the negotiation is over: the other side will read them then, so never put your limit or strategy in one.";

const INSTRUCTIONS =
  `${DEMONSTRATION} The organisations are whoever the parties name, and are not verified. ${RULES} ${AUCTION_RULES} ` +
  "Before opening or joining a table or an auction, ask your user for each setting the tool needs, and never choose one yourself. If your user chose not to bid autonomously, propose each offer or bid to them and seal it only once they have approved that exact amount. " +
  "Each side's limit is fixed before bidding: the buyer's most it may offer, the seller's least it may accept. An offer or bid beyond the user's own limit is refused, and none can be changed once sealed. " +
  "Nothing tells you when something happens: after joining, opening, offering or bidding, call wait_for_next_round, and keep calling it and following its nextStep until it is finished. " +
  "Your token starts tok_ and acts for your user: never show it to anyone. An invite starts inv_ and is the only thing to share with another party. Never tell anyone your user's limit. " +
  `${NOTES} Proof of concept, not security reviewed: in this demonstration Mattering's server holds every party's keys and seals offers and bids for them.`;

type Schema = Record<string, unknown>;
/** How long wait_for_next_round holds a call by default, and at most: under the timeouts assistants put on a tool call. */
const WAIT_DEFAULT = 40;
const WAIT_MAX = 55;
const str = (description: string): Schema => ({ type: "string", description });
const int = (description: string, minimum?: number, maximum?: number): Schema => ({ type: "integer", description, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });
const TOKEN = str("Your token: the secret code starting tok_, from the tool that opened or joined. Never an invite.");
const AUTONOMOUS = { type: "boolean", description: "As your user chooses: true to make every offer or bid yourself, false to propose each to your user and seal it only once they approve it." };
const APPROVED = { type: "boolean", description: "Required when your user chose to approve each one: true only once they have approved this exact amount. Never set it on their behalf." };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "start_negotiation",
    title: "Open a negotiation table",
    description:
      `${DEMONSTRATION} ${RULES} ` +
      "Open a table and take one side. Ask your user for each of these first, and never choose them yourself: what is being negotiated, the lowest and highest price, their own limit, how many rounds, how long each round stays open, and whether you should bid autonomously or ask them to approve each offer. " +
      "Returns your token (tok_…, secret) and an invite (inv_…) to give the other party. Round 1 begins once both sides have checked in after the other side joins. The table expires if nobody joins within 30 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["buyer", "seller"], description: "Your side. The buyer pays, the seller is paid." },
        item: str("What is being negotiated, in one line, e.g. 'A Sony Bravia 65-inch TV, boxed'."),
        minPrice: int("The lowest price either side may offer, in whole units.", 0),
        maxPrice: int("The highest price either side may offer, in whole units.", 1),
        limit: int("Your user's private limit, in whole units: as buyer the most they will pay, as seller the least they will accept. The other side never sees it during the negotiation."),
        rounds: int("How many rounds at most, as your user chooses.", MCP_LIMITS.minRounds, MCP_LIMITS.maxRounds),
        roundSeconds: int(`How long each round stays open for offers, in seconds, as your user chooses: ${MCP_LIMITS.defaultRoundSeconds} suits autonomous bidding; allow 180 or more if your user approves each offer.`, MCP_LIMITS.minRoundSeconds, MCP_LIMITS.maxRoundSeconds),
        autonomous: AUTONOMOUS,
        unit: str("The currency or unit of the prices. If left out, GBP: tell your user."),
        organisation: str("The name of the organisation you act for. If left out, 'The buyer' or 'The seller': tell your user."),
      },
      required: ["side", "item", "minPrice", "maxPrice", "limit", "rounds", "roundSeconds", "autonomous"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "join_negotiation",
    title: "Join a negotiation table",
    description:
      `${DEMONSTRATION} ${RULES} ` +
      "Join a table with the invite (inv_…) the other party shared, taking the remaining side. Ask your user first, and never choose these yourself: their own limit, and whether you should bid autonomously or ask them to approve each offer. " +
      "Returns your token (tok_…, secret) and the table's terms: read the terms back to your user. Round 1 begins once the other side checks in; call wait_for_next_round.",
    inputSchema: {
      type: "object",
      properties: {
        invite: str("The invite, starting inv_, from the party that opened the table."),
        limit: int("Your user's private limit, in whole units: as buyer the most they will pay, as seller the least they will accept."),
        autonomous: AUTONOMOUS,
        organisation: str("The name of the organisation you act for. If left out, 'The buyer' or 'The seller'."),
      },
      required: ["invite", "limit", "autonomous"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "wait_for_next_round",
    title: "Wait for the negotiation or auction to move on",
    description:
      `${DEMONSTRATION} ` +
      "Wait until something changes: another party joins or checks in, a round or bidding opens or closes, or it ends. Returns at once if there is something for you to do, and otherwise after at most maxSeconds. " +
      "The reply says what changed and gives a nextStep to follow. Nothing else will tell you, so keep calling this and acting on each nextStep until it is finished. Calling it also checks you in.",
    inputSchema: {
      type: "object",
      properties: { token: TOKEN, maxSeconds: int(`The longest to wait, in seconds. Default ${WAIT_DEFAULT}.`, 1, WAIT_MAX) },
      required: ["token"],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "make_offer",
    title: "Seal an offer for this round",
    description:
      `${DEMONSTRATION} ` +
      "Seal your side's offer for the current round of a negotiation. It is locked until the round opens, for everyone including the other side, and cannot be changed or withdrawn; only your first offer in a round counts, and a missed round ends without a deal. " +
      "An offer beyond your own limit is refused. If your user chose to approve each offer, propose it to them first and pass approvedByUser: true only once they approve that exact price. " +
      `You may add a short note to your own organisation. ${NOTES}`,
    inputSchema: {
      type: "object",
      properties: {
        token: TOKEN,
        price: int("Your offer, in whole units, within the table's price range and your limit."),
        note: str(`Optional: one sentence to your own organisation, at most ${MCP_LIMITS.maxNote} characters. ${NOTES}`),
        approvedByUser: APPROVED,
      },
      required: ["token", "price"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "negotiation_status",
    title: "Where the negotiation stands",
    description:
      `${DEMONSTRATION} ` +
      "Where your table stands now, without waiting: the current round and its timing, whether each side has sealed, every opened round's offers, and the result and its receipt once there is one. wait_for_next_round returns the same, so use this only to look without waiting. Calling it also checks you in.",
    inputSchema: { type: "object", properties: { token: TOKEN }, required: ["token"], additionalProperties: false },
    annotations: READS,
  },
  {
    name: "leave_negotiation",
    title: "Walk away from the negotiation",
    description:
      `${DEMONSTRATION} ` +
      "End the negotiation for both sides, with no deal. Only when your user asks to walk away. Offers already sealed stay sealed and recorded. The other side is told when it next waits or checks.",
    inputSchema: { type: "object", properties: { token: TOKEN }, required: ["token"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "start_auction",
    title: "Run a sealed-bid auction",
    description:
      `${DEMONSTRATION} ${AUCTION_RULES} ` +
      "Run an auction as its organiser: you do not bid. Ask your user for each of these first, and never choose them yourself: what is being auctioned, the lowest and highest bid allowed, whether the highest or the lowest bid wins, how many bidders to invite, and how long bidding stays open; and whether they want a reserve. " +
      "Returns your token (tok_…, secret) and one invite (inv_…) per bidder: give each bidder its own. Bidding opens by itself once every invited bidder has joined, or when you call open_auction with at least two. The auction expires if fewer than two join within 30 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        item: str("What is being auctioned, in one line, e.g. 'Funding of invoice INV-88213, £250,000 due in 90 days'."),
        minBid: int("The lowest bid allowed, in whole units.", 0),
        maxBid: int("The highest bid allowed, in whole units.", 1),
        rule: { type: "string", enum: ["highest-bid", "lowest-bid"], description: "Which bid wins: the highest (your user is selling) or the lowest (your user is buying, such as funding or a service)." },
        bidders: int("How many bidders to invite.", MCP_LIMITS.minBidders, MCP_LIMITS.maxBidders),
        biddingSeconds: int("How long bidding stays open once it opens, in seconds.", MCP_LIMITS.minRoundSeconds, MCP_LIMITS.maxBiddingSeconds),
        reserve: int("Optional, if your user wants one: no winner unless the best bid reaches it. Public: bidders see it."),
        unit: str("The currency or unit of the bids. If left out, GBP: tell your user."),
        organisation: str("The name of the organisation you act for. If left out, 'The organiser'."),
      },
      required: ["item", "minBid", "maxBid", "rule", "bidders", "biddingSeconds"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "join_auction",
    title: "Join a sealed-bid auction as a bidder",
    description:
      `${DEMONSTRATION} ${AUCTION_RULES} ` +
      "Join an auction with the invite (inv_…) its organiser gave you. Ask your user first, and never choose these yourself: their own limit (where the highest bid wins, the most they will bid; where the lowest wins, the least), and whether you should bid autonomously or ask them to approve the bid. " +
      "Returns your token (tok_…, secret) and the auction's terms: read them back to your user. Then call wait_for_next_round until bidding opens.",
    inputSchema: {
      type: "object",
      properties: {
        invite: str("The invite, starting inv_, from the auction's organiser."),
        limit: int("Your user's private limit, in whole units: where the highest bid wins, the most they will bid; where the lowest wins, the least."),
        autonomous: AUTONOMOUS,
        organisation: str("The name of the organisation you bid for. If left out, a number: tell your user."),
      },
      required: ["invite", "limit", "autonomous"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "place_bid",
    title: "Seal your bid",
    description:
      `${DEMONSTRATION} ` +
      "Seal your one bid in an auction while bidding is open. Nobody can read it until bidding closes and the bids open together; it cannot be changed or withdrawn. A bid beyond your user's own limit is refused. If your user chose to approve the bid, propose it to them first and pass approvedByUser: true only once they approve that exact amount.",
    inputSchema: {
      type: "object",
      properties: { token: TOKEN, amount: int("Your bid, in whole units, within the auction's range and your limit."), approvedByUser: APPROVED },
      required: ["token", "amount"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "open_auction",
    title: "Open bidding now",
    description: `${DEMONSTRATION} ` + "For the organiser: open bidding now, without waiting for every invited bidder, once at least two have joined. Only when your user asks.",
    inputSchema: { type: "object", properties: { token: TOKEN }, required: ["token"], additionalProperties: false },
    annotations: WRITES,
  },
  {
    name: "auction_status",
    title: "Where the auction stands",
    description:
      `${DEMONSTRATION} ` +
      "Where your auction stands now, without waiting: who has joined, whether bidding is open, and the result and its receipt once there is one. wait_for_next_round returns the same, so use this only to look without waiting.",
    inputSchema: { type: "object", properties: { token: TOKEN }, required: ["token"], additionalProperties: false },
    annotations: READS,
  },
] as const;

// --- talking to sessions ------------------------------------------------------

type View = Record<string, any>;
class Refusal extends Error {}
const refusal = (message: string): never => {
  throw new Refusal(message);
};

/** One session, from this server's side: as its organiser (the integrator) or as a participant. */
class Sessions {
  constructor(private readonly backend: McpBackend) {}

  get organiser(): Caller {
    return { role: "organiser", integrator: this.backend.integrator };
  }

  async call(id: string, caller: Caller, method: string, path: string, body?: unknown): Promise<View> {
    const reply = await this.backend.session(id).call({ method, path, caller, ...(body !== undefined ? { body } : {}) });
    const b = (reply.body ?? {}) as View;
    if (reply.status >= 400) refusal(reply.status === 404 && path === "/" ? "no table or auction by that code" : String(b.error?.message ?? `status ${reply.status}`));
    return b;
  }
  asOrganiser(id: string, method: string, path: string, body?: unknown): Promise<View> {
    return this.call(id, this.organiser, method, path, body);
  }
  asParticipant(token: string, method: string, path: string, body?: unknown): Promise<View> {
    return this.call(sessionOf(token)!, { role: "participant", token }, method, path, body);
  }
}

const randomHex = (bytes: number): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const secondsUntil = (iso: string, now: number): number => Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
const ENDED = ["finished", "cancelled", "expired"];
const flagOf = (v: View | undefined, key: string): boolean => v?.metadata?.[key] !== "false";

/** Who a token is for: a party to a negotiation, an auction's bidder, or an auction's organiser. */
async function whoIs(s: Sessions, token: string): Promise<{ id: string; org: View; me?: View; opener: boolean }> {
  const id = sessionOf(token) ?? refusal("That is not a token: it should start tok_.");
  const org = await s.asOrganiser(id, "GET", "/");
  // An auction's organiser holds a token this server made; only its hash is kept, in the session.
  if (org.mechanism === "sealed-bid-auction" && org.metadata?.opener === (await sha256(token))) return { id, org, opener: true };
  const me = await s.asParticipant(token, "GET", "/").catch(() => refusal("that token is not for this table or auction"));
  return { id, org, me, opener: false };
}

// --- negotiations -----------------------------------------------------------------

type Status = Record<string, any>;

/** What the side should do now, in a sentence an assistant can act on. */
function negotiationNext(st: Status, autonomous: boolean, opener: boolean): string {
  if (st.state === "finished") return st.result?.reason?.includes("left") ? "The negotiation is over: a side left it. Report that there is no deal." : "The negotiation is over. Report the result, with its receipt.";
  if (st.state?.startsWith("expired")) return "The table expired before the other side joined. Tell your user, and open a new one if they want to.";
  if (st.state === "waiting for the other side to join") return opener ? "Share the invite (it starts inv_) with the other party, never your token, then call wait_for_next_round until they join." : "Wait for the other side to join: call wait_for_next_round.";
  const current = st.currentRound;
  if (!current) return "Round 1 begins once the other side checks in. Call wait_for_next_round.";
  if (!current.youHaveSealed && current.phase === "open for offers") {
    return autonomous
      ? `Make your offer for round ${current.round} with make_offer within ${current.secondsUntilClose} seconds. Then call wait_for_next_round.`
      : `Propose an offer for round ${current.round} to your user and ask them to approve that exact price; the window closes in ${current.secondsUntilClose} seconds. Once they approve, call make_offer with approvedByUser: true, then wait_for_next_round.`;
  }
  if (!current.youHaveSealed) return `Round ${current.round} closed without an offer from you. Call wait_for_next_round until the next round begins.`;
  return `Your offer for round ${current.round} is sealed. Call wait_for_next_round until the round opens.`;
}

function receiptOf(view: View, backend: McpBackend): Record<string, unknown> | undefined {
  const r = view.receipt as { sessionId: string; log: unknown; rounds: { round: number; policyHash: string; closeRound: number; releaseRound: number; entries: Record<string, number>; outcome?: unknown }[] } | undefined | null;
  if (!r) return undefined;
  return { negotiationId: r.sessionId, log: r.log, rounds: r.rounds.map((x) => ({ round: x.round, policyHash: x.policyHash, closeRound: x.closeRound, openedAtDrandRound: x.releaseRound, outcome: x.outcome ?? null, evidence: backend.evidenceUrl(x.policyHash) })) };
}

/** A side's status: its own terms and limit, every opened round, and where the current round stands. Checks the side in. */
async function negotiationStatus(s: Sessions, backend: McpBackend, token: string, who: { id: string; org: View; me?: View }): Promise<Status> {
  let me = who.me!;
  const org = who.org;
  // Checking in: once both sides have, after both are seated, round 1 begins.
  if (org.phase === "created" && org.participants?.length === 2 && me.you?.checkedIn === false) me = await s.asParticipant(token, "POST", "/check-in", {});
  const now = Date.now();
  const you = me.you ?? {};
  const side = you.role as "buyer" | "seller";
  const them = you.counterparty as { label: string; hasBid: boolean } | null;
  const opener = you.metadata?.opener === "1";
  const ended = ENDED.includes(me.phase);
  const state =
    me.phase === "expired" ? "expired: the other side did not join in time" : ended ? "finished" : !them ? "waiting for the other side to join" : me.phase === "created" ? "waiting for both sides to check in" : "running";
  const round = me.round;
  const invite = !them && opener && me.phase !== "expired" ? (org.invitations as { code: string | null }[]).find((i) => i.code)?.code : undefined;
  const left = me.leftBy as { id: string } | undefined;
  const outcome = me.outcome as { kind: string; round: number; deal: boolean } | undefined;
  const result = left ? { deal: false, reason: `${left.id === you.id ? "you" : "the other side"} left the negotiation` } : outcome ? (({ kind: _k, round: _r, ...rest }) => rest)(outcome) : null;
  const status: Status = {
    tableId: who.id,
    yourSide: side,
    yourLimit: you.limit,
    youBidAutonomously: flagOf(you, "autonomous"),
    otherOrganisation: them?.label ?? null,
    state,
    ...(invite ? { invite } : {}),
    currentRound:
      round && !ended && me.phase !== "created"
        ? {
            round: round.round,
            of: me.terms.rounds,
            phase: now < Date.parse(round.closesAt) ? "open for offers" : "closed; offers still sealed",
            secondsUntilClose: secondsUntil(round.closesAt, now),
            secondsUntilOpen: secondsUntil(round.opensAt, now),
            youHaveSealed: you.hasBid,
            otherSideHasSealed: them?.hasBid ?? false,
          }
        : null,
    openedRounds: ((me.openedRounds ?? []) as { round: number; buyerOffer: number | null; sellerOffer: number | null; outcome: unknown }[]).map((r) => ({ round: r.round, yourOffer: side === "buyer" ? r.buyerOffer : r.sellerOffer, theirOffer: side === "buyer" ? r.sellerOffer : r.buyerOffer, outcome: r.outcome })),
    result: ended ? result : null,
    ...(ended && receiptOf(me, backend) ? { receipt: receiptOf(me, backend) } : {}),
    watchUrl: backend.watchUrl(who.id),
  };
  status.nextStep = negotiationNext(status, flagOf(you, "autonomous"), opener);
  return status;
}

/** What moved on between two statuses, in words, or undefined if nothing has. */
function negotiationChange(before: Status, after: Status): string | undefined {
  if (after.state !== before.state && after.state?.startsWith("expired")) return "The table expired: the other side did not join in time.";
  if (after.state === "finished" && before.state !== "finished") {
    const r = after.result;
    return r?.deal ? `The negotiation is over: the offers crossed, a deal at ${r.price}.` : `The negotiation is over without a deal${r?.reason ? `: ${r.reason}` : ""}.`;
  }
  if (before.state === "waiting for the other side to join" && after.state !== before.state) return `${after.otherOrganisation ?? "The other side"} has joined.${after.currentRound ? " Round 1 has begun." : ""}`;
  const opened = after.openedRounds ?? [];
  if (opened.length > (before.openedRounds ?? []).length) {
    const r = opened.at(-1)!;
    return `Round ${r.round} has opened: ${r.outcome.deal ? `the offers crossed, a deal at ${r.outcome.price}` : "no deal yet"}. Its offers are in openedRounds.`;
  }
  if ((after.currentRound?.round ?? 0) > (before.currentRound?.round ?? 0)) return `Round ${after.currentRound!.round} has begun.`;
  return undefined;
}
const negotiationOwes = (st: Status): string | undefined => (st.state === "running" && st.currentRound && !st.currentRound.youHaveSealed && st.currentRound.phase === "open for offers" ? `Round ${st.currentRound.round} is open and you have not sealed an offer for it yet.` : undefined);

// --- auctions -----------------------------------------------------------------------

/** Open bidding once every invited bidder has joined. This server is the organiser, so it can. */
async function openIfFull(s: Sessions, id: string): Promise<View> {
  const org = await s.asOrganiser(id, "GET", "/");
  if (org.phase === "created" && (org.invitations as { joined: boolean }[]).every((i) => i.joined)) return s.asOrganiser(id, "POST", "/open", {});
  return org;
}

async function auctionStatus(s: Sessions, backend: McpBackend, who: { id: string; org: View; me?: View; opener: boolean }): Promise<Status> {
  const org = who.org;
  const view = who.opener ? org : who.me!;
  const now = Date.now();
  const invited = (org.invitations as unknown[]).length;
  const joined = (org.participants as unknown[]).length;
  const round = view.round;
  const phase = view.phase as string;
  const state =
    phase === "created" ? `waiting for bidders: ${joined} of ${invited} have joined` : phase === "open" && now < Date.parse(round.closesAt) ? "bidding open" : phase === "expired" ? "expired: fewer than two bidders joined in time" : phase === "cancelled" ? "cancelled" : phase === "finished" ? "finished" : "bidding closed; the bids are still sealed";
  const outcome = view.outcome as { winner: { label: string; amount: number } | null; reserveMet?: boolean; bids?: { label: string; amount?: number; status: string }[] } | undefined;
  const you = view.you as View | undefined;
  const status: Status = {
    auctionId: who.id,
    youAre: who.opener ? "the organiser" : "a bidder",
    terms: view.terms,
    state,
    bidders: { invited, joined },
    ...(who.opener ? { invites: (org.invitations as { code: string | null }[]).filter((i) => i.code).map((i) => i.code), joinedBidders: (org.participants as { label: string; hasBid: boolean }[]).map((p) => ({ name: p.label, hasBid: p.hasBid })) } : { you: { name: you!.label, yourLimit: Number(you!.metadata?.limit), youBidAutonomously: flagOf(you, "autonomous"), youHaveBid: you!.hasBid } }),
    bidding: round && (phase === "open" || phase === "closed" || phase === "released") ? { phase: now < Date.parse(round.closesAt) ? "open" : "closed", secondsUntilClose: secondsUntil(round.closesAt, now), secondsUntilBidsOpen: secondsUntil(round.opensAt, now), bidsSealed: round.bids } : null,
    result: outcome ? { winner: outcome.winner ? { name: outcome.winner.label, amount: outcome.winner.amount } : null, ...(outcome.reserveMet !== undefined ? { reserveMet: outcome.reserveMet } : {}), ...(outcome.bids ? { bids: outcome.bids.map((b) => ({ name: b.label, amount: b.amount ?? null, status: b.status })) } : {}), ...(you?.yourBid ? { yourBid: you.yourBid.amount ?? null } : {}) } : null,
    ...(view.receipt ? { receipt: receiptOf(view, backend) } : {}),
  };
  status.nextStep = auctionNext(status, who.opener, you);
  return status;
}

function auctionNext(st: Status, opener: boolean, you: View | undefined): string {
  const phase = st.state as string;
  if (phase === "finished") return "The auction is over. Report the result, with its receipt.";
  if (phase.startsWith("expired")) return "The auction expired: fewer than two bidders joined in time. Tell your user.";
  if (phase === "cancelled") return "The auction was cancelled. Tell your user.";
  if (phase.startsWith("waiting")) {
    if (!opener) return "Bidding opens once every invited bidder has joined, or when the organiser opens it. Call wait_for_next_round.";
    return st.bidders.joined >= 2
      ? `${st.bidders.joined} of ${st.bidders.invited} bidders have joined. Bidding opens by itself once all have; if your user wants to start now, call open_auction. Otherwise call wait_for_next_round.`
      : "Give each invite (it starts inv_) to one bidder, never your token, then call wait_for_next_round until they join.";
  }
  if (opener) return "Bidding is under way, and nobody can read a bid yet. Call wait_for_next_round until the result.";
  if (phase === "bidding open" && !you?.hasBid) {
    const s = st.bidding?.secondsUntilClose;
    return flagOf(you, "autonomous") ? `Place your bid with place_bid within ${s} seconds. Then call wait_for_next_round.` : `Propose a bid to your user and ask them to approve that exact amount; bidding closes in ${s} seconds. Once they approve, call place_bid with approvedByUser: true, then wait_for_next_round.`;
  }
  return you?.hasBid ? "Your bid is sealed. Call wait_for_next_round until the result." : "Bidding closed without a bid from you. Call wait_for_next_round until the result.";
}

function auctionChange(before: Status, after: Status): string | undefined {
  if (after.state === before.state && after.bidders.joined === before.bidders.joined) return undefined;
  if (after.state === "finished") {
    const w = after.result?.winner;
    return w ? `The auction is over: ${w.name} won with ${w.amount}.` : `The auction is over with no winner${after.result?.reserveMet === false ? ": no bid reached the reserve" : ""}.`;
  }
  if (after.state.startsWith("expired")) return "The auction expired: fewer than two bidders joined in time.";
  if (after.state === "bidding open" && before.state !== "bidding open") return "Bidding is open.";
  if (after.state.startsWith("bidding closed") && !before.state.startsWith("bidding closed")) return "Bidding has closed; the bids are still sealed until the public clock releases them.";
  if (after.bidders.joined > before.bidders.joined) return `${after.bidders.joined} of ${after.bidders.invited} bidders have joined.`;
  return after.state !== before.state ? `The auction is now: ${after.state}.` : undefined;
}
const auctionOwes = (st: Status): string | undefined => (st.youAre === "a bidder" && st.state === "bidding open" && !st.you?.youHaveBid ? "Bidding is open and you have not placed your bid yet." : undefined);

// --- tools --------------------------------------------------------------------------

/** What the user must decide first, in words for the assistant to ask about. */
const SETTINGS: Record<string, Record<string, string>> = {
  start_negotiation: {
    item: "what is being negotiated",
    minPrice: "the lowest price either side may offer",
    maxPrice: "the highest price either side may offer",
    limit: "their own limit (as seller, the least they will accept; as buyer, the most they will pay)",
    rounds: "how many rounds at most",
    roundSeconds: "how long each round should stay open",
    autonomous: "whether you should bid autonomously or ask them to approve each offer",
  },
  join_negotiation: {
    limit: "their own limit (as buyer, the most they will pay; as seller, the least they will accept)",
    autonomous: "whether you should bid autonomously or ask them to approve each offer",
  },
  start_auction: {
    item: "what is being auctioned",
    minBid: "the lowest bid allowed",
    maxBid: "the highest bid allowed",
    rule: "whether the highest or the lowest bid wins",
    bidders: "how many bidders to invite",
    biddingSeconds: "how long bidding should stay open",
  },
  join_auction: {
    limit: "their own limit (where the highest bid wins, the most they will bid; where the lowest wins, the least)",
    autonomous: "whether you should bid autonomously or ask them to approve the bid",
  },
};
function missingSettings(tool: string, args: Record<string, unknown>): string[] {
  return Object.entries(SETTINGS[tool] ?? {}).filter(([key]) => args[key] === undefined || args[key] === null || args[key] === "").map(([, words]) => words);
}
const listOf = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join("; ")}; and ${items.at(-1)}`);

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) refusal(`${field}: want a whole number from ${min} to ${max}`);
  return value as number;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") refusal(`${field}: want true or false`);
  return value as boolean;
}
const tokenOf = (value: unknown): string => {
  if (typeof value === "string" && value.startsWith("inv_")) refusal("That is the invite. Pass your token, starting tok_.");
  if (typeof value !== "string" || !value.startsWith("tok_") || !sessionOf(value)) refusal("That is not a token: it should start tok_.");
  return value as string;
};
const inviteOf = (value: unknown): string => {
  if (typeof value === "string" && value.startsWith("tok_")) refusal("That is a token, which is secret, not an invite. Ask for the invite: it starts inv_.");
  if (typeof value !== "string" || !value.startsWith("inv_") || !sessionOf(value)) refusal("That is not an invite: it should start inv_.");
  return value as string;
};
const quorumBy = (): string => new Date(Date.now() + MCP_LIMITS.joinWithinMs).toISOString();

/** Each tool: what it does, returning the reply's data. */
async function run(name: string, args: Record<string, any>, s: Sessions, backend: McpBackend): Promise<Status> {
  switch (name) {
    case "start_negotiation": {
      const side = args.side === "buyer" || args.side === "seller" ? (args.side as "buyer" | "seller") : refusal('side: want "buyer" or "seller"');
      const minPrice = whole(args.minPrice, "minPrice", 0, 1e12);
      const maxPrice = whole(args.maxPrice, "maxPrice", minPrice + 1, 1e12);
      const limit = whole(args.limit, "limit", minPrice, maxPrice);
      const rounds = whole(args.rounds, "rounds", MCP_LIMITS.minRounds, MCP_LIMITS.maxRounds);
      const roundSeconds = whole(args.roundSeconds, "roundSeconds", MCP_LIMITS.minRoundSeconds, MCP_LIMITS.maxRoundSeconds);
      const autonomous = flag(args.autonomous, "autonomous");
      if (!(await backend.allow())) refusal("today's allowance of new negotiation tables is used up; try again tomorrow");
      const unit = typeof args.unit === "string" && args.unit.trim() ? args.unit : "GBP";
      const organisation = typeof args.organisation === "string" && args.organisation.trim() ? args.organisation : side === "buyer" ? "The buyer" : "The seller";
      const other = side === "buyer" ? "seller" : "buyer";
      const id = newSessionId();
      const created = await s.asOrganiser(id, "POST", "/create", {
        id,
        mechanism: "negotiation",
        terms: { item: args.item, unit, minPrice, maxPrice, rounds },
        timing: { biddingSeconds: roundSeconds, quorumBy: quorumBy() },
        sealing: "server",
        watch: true,
        invitations: [{ role: side, label: organisation }, { role: other }],
      });
      const mine = (created.invitations as { code: string; role: string }[]).find((i) => i.role === side)!;
      const invite = (created.invitations as { code: string; role: string }[]).find((i) => i.role === other)!.code;
      const joined = await s.call(id, { role: "public" }, "POST", "/join", { invitation: mine.code, limit, metadata: { autonomous: String(autonomous), opener: "1" } });
      const defaultsUsed = [...(args.unit === undefined ? [`unit: ${unit}`] : []), ...(args.organisation === undefined ? [`organisation: ${organisation}`] : [])];
      return { tableId: id, side, token: joined.token, invite, terms: { item: created.terms.item, unit, minPrice, maxPrice, rounds, roundSeconds }, yourLimit: limit, autonomous, joinBy: quorumBy(), watchUrl: backend.watchUrl(id), ...(defaultsUsed.length ? { defaultsUsed } : {}) };
    }
    case "join_negotiation": {
      const invite = inviteOf(args.invite);
      const id = sessionOf(invite)!;
      const org = await s.asOrganiser(id, "GET", "/");
      if (org.mechanism === "sealed-bid-auction") refusal("That invite is for an auction: use join_auction.");
      if (org.phase === "expired") refusal("this table was not joined in time and has expired; ask the other party to open a new one");
      const autonomous = flag(args.autonomous, "autonomous");
      const joined = await s.call(id, { role: "public" }, "POST", "/join", { invitation: invite, limit: args.limit, ...(typeof args.organisation === "string" && args.organisation.trim() ? { label: args.organisation } : {}), metadata: { autonomous: String(autonomous) } });
      const you = joined.session.you;
      return { tableId: id, side: you.role, token: joined.token, terms: { ...joined.session.terms, roundSeconds: joined.session.timing.biddingSeconds }, otherOrganisation: you.counterparty?.label ?? null, yourLimit: you.limit, autonomous, watchUrl: backend.watchUrl(id) };
    }
    case "make_offer": {
      const token = tokenOf(args.token);
      const who = await whoIs(s, token);
      if (who.org.mechanism === "sealed-bid-auction") refusal("This is an auction: use place_bid.");
      const st = await negotiationStatus(s, backend, token, who);
      if (st.state === "finished" || st.state.startsWith("expired")) refusal("the negotiation is over");
      const current = st.currentRound;
      if (!current) refusal(st.otherOrganisation ? "round 1 has not begun: it begins once both sides have checked in; call wait_for_next_round" : "the other side has not joined yet; share the invite");
      if (current.youHaveSealed) refusal(`you have already sealed an offer for round ${current.round}; only the first counts`);
      if (current.phase !== "open for offers") refusal(`round ${current.round} has closed; wait for it to open and the next to begin`);
      const unit = who.me!.terms.unit;
      const price = whole(args.price, "price", who.me!.terms.minPrice, who.me!.terms.maxPrice);
      // The firm's own mandate refuses an offer beyond the limit, whatever the assistant asks.
      if (st.yourSide === "buyer" ? price > st.yourLimit : price < st.yourLimit) refusal(`your firm's mandate lets you ${st.yourSide === "buyer" ? `pay at most ${st.yourLimit}` : `accept no less than ${st.yourLimit}`} ${unit}`);
      // The server cannot see the conversation, so this rests on the assistant saying so; without it, the assistant is sent back to ask.
      if (!st.youBidAutonomously && args.approvedByUser !== true) refusal(`your user chose to approve each offer: ask them to approve ${price} ${unit} for round ${current.round}, then call make_offer again with approvedByUser: true`);
      const sealed = await s.asParticipant(token, "POST", "/bids", { price, ...(typeof args.note === "string" && args.note.trim() ? { note: args.note.slice(0, MCP_LIMITS.maxNote) } : {}) });
      return { round: sealed.round, sealed: true, price, logIndex: sealed.receipt?.index, opensAt: sealed.opensAt, closesAt: sealed.closesAt };
    }
    case "leave_negotiation": {
      const token = tokenOf(args.token);
      const who = await whoIs(s, token);
      if (who.org.mechanism === "sealed-bid-auction") refusal("This is an auction: a bidder cannot walk away once it has joined.");
      if (ENDED.includes(who.me!.phase)) refusal("the negotiation is already over");
      await s.asParticipant(token, "POST", "/cancel", {});
      return { tableId: who.id, left: true, result: { deal: false, reason: "you left the negotiation" } };
    }
    case "start_auction": {
      const minBid = whole(args.minBid, "minBid", 0, 1e12);
      const maxBid = whole(args.maxBid, "maxBid", minBid + 1, 1e12);
      const rule = args.rule === "highest-bid" || args.rule === "lowest-bid" ? args.rule : refusal('rule: want "highest-bid" or "lowest-bid"');
      const bidders = whole(args.bidders, "bidders", MCP_LIMITS.minBidders, MCP_LIMITS.maxBidders);
      const biddingSeconds = whole(args.biddingSeconds, "biddingSeconds", MCP_LIMITS.minRoundSeconds, MCP_LIMITS.maxBiddingSeconds);
      const reserve = args.reserve === undefined ? undefined : whole(args.reserve, "reserve", minBid, maxBid);
      if (!(await backend.allow())) refusal("today's allowance of new auctions is used up; try again tomorrow");
      const unit = typeof args.unit === "string" && args.unit.trim() ? args.unit : "GBP";
      const organisation = typeof args.organisation === "string" && args.organisation.trim() ? args.organisation : "The organiser";
      const id = newSessionId();
      const token = `tok_${id.slice(4)}_${randomHex(16)}`;
      const created = await s.asOrganiser(id, "POST", "/create", {
        id,
        mechanism: "sealed-bid-auction",
        terms: { item: args.item, unit, minBid, maxBid, rule, ...(reserve !== undefined ? { reserve } : {}) },
        timing: { biddingSeconds, quorumBy: quorumBy() },
        confidentiality: "organiser",
        sealing: "server",
        invitations: Array.from({ length: bidders }, () => ({})),
        metadata: { opener: await sha256(token), organisation },
      });
      const defaultsUsed = [...(args.unit === undefined ? [`unit: ${unit}`] : []), ...(args.organisation === undefined ? [`organisation: ${organisation}`] : [])];
      return { auctionId: id, token, invites: (created.invitations as { code: string }[]).map((i) => i.code), terms: created.terms, biddingSeconds, joinBy: quorumBy(), ...(defaultsUsed.length ? { defaultsUsed } : {}) };
    }
    case "join_auction": {
      const invite = inviteOf(args.invite);
      const id = sessionOf(invite)!;
      const org = await s.asOrganiser(id, "GET", "/");
      if (org.mechanism !== "sealed-bid-auction") refusal("That invite is for a negotiation: use join_negotiation.");
      if (org.phase === "expired") refusal("this auction was not joined in time and has expired");
      const limit = whole(args.limit, "limit", org.terms.minBid, org.terms.maxBid);
      const autonomous = flag(args.autonomous, "autonomous");
      const joined = await s.call(id, { role: "public" }, "POST", "/join", { invitation: invite, ...(typeof args.organisation === "string" && args.organisation.trim() ? { label: args.organisation } : {}), metadata: { autonomous: String(autonomous), limit: String(limit) } });
      const after = await openIfFull(s, id);
      return { auctionId: id, token: joined.token, name: joined.participant.label, terms: org.terms, organiser: org.metadata?.organisation ?? "The organiser", yourLimit: limit, autonomous, biddingOpen: after.phase === "open" };
    }
    case "place_bid": {
      const token = tokenOf(args.token);
      const who = await whoIs(s, token);
      if (who.org.mechanism !== "sealed-bid-auction") refusal("This is a negotiation: use make_offer.");
      if (who.opener) refusal("you are the organiser: you do not bid");
      const st = await auctionStatus(s, backend, who);
      if (st.state.startsWith("waiting")) refusal("bidding has not opened yet; call wait_for_next_round");
      if (st.you.youHaveBid) refusal("your bid is already sealed; only one counts");
      if (st.state !== "bidding open") refusal("bidding has closed");
      const terms = who.me!.terms;
      const amount = whole(args.amount, "amount", terms.minBid, terms.maxBid);
      const limit = st.you.yourLimit as number;
      if (terms.rule === "highest-bid" ? amount > limit : amount < limit) refusal(`your user's limit lets you bid ${terms.rule === "highest-bid" ? `at most ${limit}` : `no less than ${limit}`} ${terms.unit}`);
      if (!st.you.youBidAutonomously && args.approvedByUser !== true) refusal(`your user chose to approve the bid: ask them to approve ${amount} ${terms.unit}, then call place_bid again with approvedByUser: true`);
      const sealed = await s.asParticipant(token, "POST", "/bids", { amount });
      return { sealed: true, amount, logIndex: sealed.receipt?.index, closesAt: sealed.closesAt, opensAt: sealed.opensAt };
    }
    case "open_auction": {
      const token = tokenOf(args.token);
      const who = await whoIs(s, token);
      if (!who.opener) refusal("only the auction's organiser can open bidding");
      await s.asOrganiser(who.id, "POST", "/open", {});
      return auctionStatus(s, backend, { ...who, org: await s.asOrganiser(who.id, "GET", "/") });
    }
    case "negotiation_status":
    case "auction_status": {
      const token = tokenOf(args.token);
      const who = await whoIs(s, token);
      return who.org.mechanism === "sealed-bid-auction" ? auctionStatus(s, backend, who) : negotiationStatus(s, backend, token, who);
    }
    case "wait_for_next_round": {
      const token = tokenOf(args.token);
      const seconds = typeof args.maxSeconds === "number" && Number.isFinite(args.maxSeconds) ? Math.max(1, Math.min(WAIT_MAX, Math.floor(args.maxSeconds))) : WAIT_DEFAULT;
      return waitForChange(s, backend, token, seconds);
    }
    default:
      return refusal(`No tool called ${name}.`);
  }
}

/** Hold the call until things move on, looking once a second, for at most `seconds`. */
async function waitForChange(s: Sessions, backend: McpBackend, token: string, seconds: number): Promise<Status> {
  const look = async (): Promise<{ auction: boolean; st: Status }> => {
    const who = await whoIs(s, token);
    const auction = who.org.mechanism === "sealed-bid-auction";
    return { auction, st: auction ? await auctionStatus(s, backend, who) : await negotiationStatus(s, backend, token, who) };
  };
  const first = await look();
  const before = first.st;
  const over = first.auction ? ENDED.some((p) => before.state.startsWith(p)) || before.state === "finished" : before.state === "finished" || before.state.startsWith("expired");
  if (over) return { ...before, changed: `It is over${before.state.startsWith("expired") ? ": it expired" : ""}.` };
  const owes = first.auction ? auctionOwes(before) : negotiationOwes(before);
  if (owes) return { ...before, changed: owes };
  const until = Date.now() + seconds * 1000;
  let latest = before;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    latest = (await look()).st;
    const moved = first.auction ? auctionChange(before, latest) : negotiationChange(before, latest);
    if (moved) return { ...latest, changed: moved };
  }
  return { ...latest, changed: `Nothing has changed in ${seconds} seconds. Call wait_for_next_round again.` };
}

// --- replies --------------------------------------------------------------------

/** The receipt in words: what anyone can check the result against. */
function receiptLines(r: Status): string {
  const receipt = r.receipt as { negotiationId: string; rounds: { round: number; policyHash: string; openedAtDrandRound: number; evidence?: string }[] } | undefined;
  if (!receipt) return "";
  const where = r.watchUrl ? `Anyone can check every round in the browser at ${String(r.watchUrl)}, or download the evidence there and run \`mattering check-demo\`.` : "Anyone can fetch the evidence at that address and check it with `@mattering/core`.";
  return `\nReceipt (${receipt.negotiationId}): ` + receipt.rounds.map((x) => `round ${x.round}: policy ${x.policyHash.slice(0, 16)}…, opened at drand round ${x.openedAtDrandRound}${x.evidence ? `, evidence ${x.evidence}` : ""}`).join("; ") + `.\n${where}`;
}

/** What a tool says it did, in words for the assistant, with the data beside it. */
function summary(tool: string, r: Status): string {
  const mode = r.autonomous ? "bidding autonomously" : "asking your user to approve each offer";
  switch (tool) {
    case "start_negotiation":
      return [
        `The table is open. You are the ${r.side}, ${mode}.`,
        `Share only this invite with the other party: ${r.invite}`,
        `Your token, secret, for every other call: ${r.token}`,
        ...(Array.isArray(r.defaultsUsed) ? [`Defaults used, tell your user: ${(r.defaultsUsed as string[]).join(", ")}.`] : []),
        `The table expires unless joined by ${r.joinBy}. Watch at ${r.watchUrl}`,
        "Now call wait_for_next_round until the other side joins.",
      ].join("\n");
    case "join_negotiation":
      return `You have joined as the ${r.side}, ${mode}. Read the terms back to your user.\nYour token, secret, for every other call: ${r.token}\nWatch at ${r.watchUrl}\nRound 1 begins once the other side checks in: call wait_for_next_round.`;
    case "make_offer":
      return `Sealed: your offer of ${r.price} for round ${r.round}. Nobody can read it until the round opens at ${r.opensAt}. Now call wait_for_next_round.`;
    case "leave_negotiation":
      return "You have left the negotiation. It is over for both sides, with no deal.";
    case "start_auction":
      return [
        `The auction is set up. You are its organiser and do not bid.`,
        `Give each bidder one of these invites, and nothing else: ${(r.invites as string[]).join(" ")}`,
        `Your token, secret, for every other call: ${r.token}`,
        ...(Array.isArray(r.defaultsUsed) ? [`Defaults used, tell your user: ${(r.defaultsUsed as string[]).join(", ")}.`] : []),
        `Bidding opens once every bidder has joined. The auction expires unless two have joined by ${r.joinBy}.`,
        "Now call wait_for_next_round.",
      ].join("\n");
    case "join_auction":
      return `You have joined the auction as ${r.name}, ${r.autonomous ? "bidding autonomously" : "asking your user to approve the bid"}. Read the terms back to your user.\nYour token, secret, for every other call: ${r.token}\n${r.biddingOpen ? "Bidding is open." : "Bidding opens once every invited bidder has joined."} Call wait_for_next_round.`;
    case "place_bid":
      return `Sealed: your bid of ${r.amount}. Nobody can read it until bidding closes and the bids open at ${r.opensAt}. Now call wait_for_next_round.`;
    case "wait_for_next_round":
      return `${String(r.changed)}\nNext: ${String(r.nextStep)}${receiptLines(r)}`;
    default:
      return `Next: ${String(r.nextStep ?? "")}${receiptLines(r)}`;
  }
}

/**
 * A tool's reply. Every reply starts with the demonstration line. Opening and
 * joining also carry the full environment and the rules; later replies stay
 * short, as an assistant reads many of them.
 */
function answer(name: string, body: Status, backend: McpBackend) {
  const full = name.startsWith("start_") || name.startsWith("join_");
  const rules = name.endsWith("_auction") ? AUCTION_RULES : RULES;
  const structured = full ? { environment: environment(backend.clock), rules, ...body } : { environment: "demonstration", ...body };
  return { content: [{ type: "text" as const, text: `[${DEMONSTRATION}]\n${summary(name, body)}\n${JSON.stringify(structured, null, 2)}` }], structuredContent: structured };
}

async function callTool(name: string, args: Record<string, unknown>, backend: McpBackend): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  if (!TOOLS.some((t) => t.name === name)) return refuse(`No tool called ${name}.`);
  const missing = missingSettings(name, args);
  if (missing.length) return refuse(`Not yet: ask your user for ${listOf(missing)}, then call ${name} again. Do not choose these yourself.`);
  try {
    return answer(name, await run(name, args, new Sessions(backend), backend), backend);
  } catch (error) {
    if (error instanceof Refusal) return refuse(/^(Not yet|That|No tool|This)/.test(error.message) ? error.message : `Refused: ${error.message}`);
    throw error;
  }
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const error = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });

/** Answer one JSON-RPC message, or undefined for a notification or a response. */
export async function handleMcpMessage(message: Message, backend: McpBackend): Promise<unknown> {
  if (message === null || typeof message !== "object" || message.jsonrpc !== "2.0") return error(null, -32600, "invalid request");
  const { id, method } = message;
  if (typeof method !== "string") return undefined; // a response to us; we send no requests
  if (id === undefined) return undefined; // a notification, such as notifications/initialized
  const params = (message.params ?? {}) as Record<string, unknown>;
  try {
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return result(id, { protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: TOOLS });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = params.arguments !== null && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        return result(id, await callTool(name, args, backend));
      }
      case "resources/list":
        return result(id, { resources: [] });
      case "prompts/list":
        return result(id, { prompts: [] });
      default:
        return error(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    return error(id, -32603, (e as Error).message);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
};

/**
 * The Streamable HTTP endpoint, as plain status, headers and body, so that a
 * Node server and a Worker can both serve it. `allowOrigin` guards a server on
 * a laptop against pages on other sites calling it through the browser.
 */
export async function handleMcpHttp(method: string, headers: { get(name: string): string | null }, readBody: () => Promise<string>, backend: McpBackend, allowOrigin: (origin: string) => boolean = () => true): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const origin = headers.get("origin");
  if (origin && !allowOrigin(origin)) return { status: 403, headers: { "content-type": "application/json" }, body: JSON.stringify(error(null, -32000, "origin not allowed")) };
  if (method === "OPTIONS") return { status: 204, headers: CORS, body: "" };
  // No server-initiated stream and no sessions: GET and DELETE are not offered.
  if (method !== "POST") return { status: 405, headers: { ...CORS, allow: "POST, OPTIONS", "content-type": "application/json" }, body: JSON.stringify(error(null, -32000, "this server answers POST only")) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody());
  } catch {
    return { status: 400, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(error(null, -32700, "parse error")) };
  }
  const messages = Array.isArray(parsed) ? (parsed as Message[]) : [parsed as Message];
  const replies = (await Promise.all(messages.map((m) => handleMcpMessage(m, backend)))).filter((r) => r !== undefined);
  if (replies.length === 0) return { status: 202, headers: CORS, body: "" };
  return { status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(Array.isArray(parsed) ? replies : replies[0]) };
}
