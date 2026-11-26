/**
 * Mattering as an MCP server: tools that let an AI assistant (Claude,
 * ChatGPT, or any MCP client) open or join a sealed negotiation table and
 * negotiate for one side of it. Served over MCP's Streamable HTTP transport,
 * answering each POST with plain JSON: no sessions, no streams. Each tool
 * call is routed to its table by the table id at the front of the token or
 * invite, so the same code runs on a laptop and in a Cloudflare Worker.
 */
import type { Reply } from "@mattering/witness/routes";
import { TABLE_LIMITS, isInvite, newTableId, tableOf } from "./table.ts";

/** Where tables live: in this process on a laptop, Durable Objects on Cloudflare. */
export interface TableDirectory {
  call(tableId: string, method: string, path: string, body?: unknown): Promise<Reply>;
  /** Where anyone can watch a table. */
  watchUrl(tableId: string): string;
  /** The clock the tables run on: drand in public, simulated only for development. */
  clock: "live" | "simulated";
  /** Where anyone can fetch a round's evidence from the shared log. */
  evidenceUrl(policyHash: string): string;
}

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
    keys: "Mattering's server holds both parties' keys and seals offers for them. In a live environment each party would seal on its own machine.",
    clock: clock === "live" ? "drand quicknet, the public randomness beacon" : "simulated on the server, for development only",
    liveEnvironment: "None exists yet. A live environment would be a separate server address with its own terms.",
  };
}
/** The one line every description and reply starts with. */
const DEMONSTRATION = "Demonstration environment: offers are sealed and recorded for real, but they are not legally binding and no payment is made or arranged.";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "mattering", title: "Mattering sealed negotiation", version: "0.2.0" };

/** The rules of a table, said where an assistant reads them before it opens or joins one. */
const RULES =
  "Two parties only, one buyer and one seller: this is not an auction with several bidders. " +
  "Each round, both sides seal one offer and the two open together. If the buyer's offer is at least the seller's, the deal is at the midpoint of the two; otherwise the next round begins, up to the agreed number of rounds, after which there is no deal.";
/** Who reads the notes, said wherever a note can be written. */
const NOTES = "Notes are shown on the watch page, which both sides have, once the negotiation is over: the other side will read them then, so never put your limit or strategy in one.";

const INSTRUCTIONS =
  `${DEMONSTRATION} The organisations are whoever the parties name, and are not verified. ${RULES} ` +
  "Before opening or joining a table, ask your user for each setting the tool needs, and never choose one yourself: the opener's item, price range, own limit, number of rounds, round length and whether to bid autonomously; the joiner's own limit and whether to bid autonomously. If your user chose not to bid autonomously, propose each offer to them and seal it only once they have approved that exact price. " +
  "Each side's limit is fixed in its firm's mandate before the first round: the buyer's most it may offer, the seller's least it may accept. Neither side can see the other's offer until both open together, when a public clock (drand) releases the key. An offer cannot be changed once sealed, and an offer beyond the party's own limit is refused. " +
  "Nothing tells you when something happens: after joining, opening or offering, call wait_for_next_round, and keep calling it and following its nextStep until the negotiation is finished. " +
  "Your token starts tok_ and acts for your side: never show it to anyone. The invite starts inv_ and is the only thing to share with the other party. Never tell the other side your limit. " +
  `${NOTES} Proof of concept, not security reviewed: in this demonstration Mattering's server holds both parties' keys and seals offers for them.`;

type Schema = Record<string, unknown>;
/** How long wait_for_next_round holds a call by default, and at most: under the timeouts assistants put on a tool call. */
const WAIT_DEFAULT = 40;
const WAIT_MAX = 55;
const str = (description: string): Schema => ({ type: "string", description });
const int = (description: string, minimum?: number, maximum?: number): Schema => ({ type: "integer", description, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });
const TOKEN = str("Your token: the secret code starting tok_, from start_negotiation or join_negotiation. Never the invite.");
const AUTONOMOUS = { type: "boolean", description: "As your user chooses: true to make every offer yourself, false to propose each offer to your user and seal it only once they approve it." };

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
        rounds: int("How many rounds at most, as your user chooses.", TABLE_LIMITS.minRounds, TABLE_LIMITS.maxRounds),
        roundSeconds: int(`How long each round stays open for offers, in seconds, as your user chooses: ${TABLE_LIMITS.defaultRoundSeconds} suits autonomous bidding; allow 180 or more if your user approves each offer.`, TABLE_LIMITS.minRoundSeconds, TABLE_LIMITS.maxRoundSeconds),
        autonomous: AUTONOMOUS,
        unit: str("The currency or unit of the prices. If left out, GBP: tell your user."),
        organisation: str("The name of the organisation you act for. If left out, 'The buyer' or 'The seller': tell your user."),
      },
      required: ["side", "item", "minPrice", "maxPrice", "limit", "rounds", "roundSeconds", "autonomous"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "wait_for_next_round",
    title: "Wait for the negotiation to move on",
    description:
      `${DEMONSTRATION} ` +
      "Wait until something changes at your table: the other side joins or checks in, a round begins or opens, or the negotiation ends. Returns at once if there is something for you to do, and otherwise after at most maxSeconds. " +
      "The reply says what changed and gives a nextStep to follow. Nothing else will tell you, so keep calling this and acting on each nextStep until the negotiation is finished. Calling it also checks you in.",
    inputSchema: {
      type: "object",
      properties: { token: TOKEN, maxSeconds: int(`The longest to wait, in seconds. Default ${WAIT_DEFAULT}.`, 1, WAIT_MAX) },
      required: ["token"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "make_offer",
    title: "Seal an offer for this round",
    description:
      `${DEMONSTRATION} ` +
      "Seal your side's offer for the current round. It is locked until the round opens, for everyone including the other side, and cannot be changed or withdrawn; only your first offer in a round counts, and a missed round ends without a deal. " +
      "An offer beyond your own limit is refused. If your user chose to approve each offer, propose it to them first and pass approvedByUser: true only once they approve that exact price. " +
      `You may add a short note to your own organisation. ${NOTES}`,
    inputSchema: {
      type: "object",
      properties: {
        token: TOKEN,
        price: int("Your offer, in whole units, within the table's price range and your limit."),
        note: str(`Optional: one sentence to your own organisation, at most ${TABLE_LIMITS.maxNote} characters. ${NOTES}`),
        approvedByUser: { type: "boolean", description: "Required when your user chose to approve each offer: true only once they have approved this exact price for this round. Never set it on their behalf." },
      },
      required: ["token", "price"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "negotiation_status",
    title: "Where the negotiation stands",
    description:
      `${DEMONSTRATION} ` +
      "Where your table stands now, without waiting: the current round and its timing, whether each side has sealed, every opened round's offers, and the result and its receipt once there is one. wait_for_next_round returns the same, so use this only to look without waiting. Calling it also checks you in.",
    inputSchema: { type: "object", properties: { token: TOKEN }, required: ["token"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
] as const;

/** The receipt in words: what anyone can check the result against. */
function receiptLines(r: Record<string, unknown>): string {
  const receipt = r.receipt as { negotiationId: string; rounds: { round: number; policyHash: string; openedAtDrandRound: number; evidence?: string }[] } | undefined;
  if (!receipt) return "";
  return `\nReceipt (${receipt.negotiationId}): ` + receipt.rounds.map((x) => `round ${x.round}: policy ${x.policyHash.slice(0, 16)}…, opened at drand round ${x.openedAtDrandRound}${x.evidence ? `, evidence ${x.evidence}` : ""}`).join("; ") + `.\nAnyone can check every round in the browser at ${String(r.watchUrl)}, or download the evidence there and run \`mattering check-demo\`.`;
}

/** What a tool says it did, in words for the assistant, with the data beside it. */
function summary(tool: string, r: Record<string, unknown>): string {
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
    case "wait_for_next_round":
      return `${String(r.changed)}\nNext: ${String(r.nextStep)}${receiptLines(r)}`;
    default:
      return `Next: ${String(r.nextStep ?? "")}${receiptLines(r)}`;
  }
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const error = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });

/** What the user must decide before a table is opened or joined, in words for the assistant to ask about. */
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
};
function missingSettings(tool: string, args: Record<string, unknown>): string[] {
  return Object.entries(SETTINGS[tool] ?? {}).filter(([key]) => args[key] === undefined || args[key] === null || args[key] === "").map(([, words]) => words);
}
const listOf = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join("; ")}; and ${items.at(-1)}`);

/**
 * A tool's reply. Every reply starts with the demonstration line. Opening and
 * joining also carry the full environment and the terms; later replies stay
 * short, as an assistant reads many of them.
 */
function answer(name: string, body: Record<string, unknown>, tables: TableDirectory) {
  const full = name === "start_negotiation" || name === "join_negotiation";
  const structured = full ? { environment: environment(tables.clock), rules: RULES, ...body } : { environment: "demonstration", ...body };
  return { content: [{ type: "text" as const, text: `[${DEMONSTRATION}]\n${summary(name, body)}\n${JSON.stringify(structured, null, 2)}` }], structuredContent: structured };
}

/** Add what only the front end knows: where to watch, and where each round's evidence is. */
function addLinks(body: Record<string, unknown>, tables: TableDirectory): void {
  if (typeof body.tableId === "string") body.watchUrl = tables.watchUrl(body.tableId);
  const receipt = body.receipt as { rounds?: { policyHash: string; evidence?: string }[] } | undefined;
  for (const r of receipt?.rounds ?? []) r.evidence = tables.evidenceUrl(r.policyHash);
}

type Status = { state?: string; currentRound?: { round: number; youHaveSealed: boolean; phase: string } | null; openedRounds?: { round: number; outcome: { deal: boolean; reason?: string; price?: number } }[]; result?: { deal: boolean; price?: number; reason?: string } | null; nextStep?: string; otherOrganisation?: string | null };

/** What moved on between two statuses, in words, or undefined if nothing has. */
function change(before: Status, after: Status): string | undefined {
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

/** Hold the call until the table moves on, asking it once a second, for at most `seconds`. */
async function waitForChange(id: string, token: unknown, seconds: number, tables: TableDirectory): Promise<{ status: number; body: Record<string, unknown> }> {
  const ask = async () => {
    const reply = await tables.call(id, "POST", "/status", { token });
    return { status: reply.status, body: (reply.body ?? {}) as Record<string, unknown> };
  };
  const first = await ask();
  if (first.status !== 200) return first;
  const before = first.body as Status;
  // Already something to do, or nothing more will happen: say so at once.
  if (before.state === "finished" || before.state?.startsWith("expired")) return { status: 200, body: { ...first.body, changed: before.state === "finished" ? "The negotiation is over." : "The table has expired." } };
  if (before.state === "running" && before.currentRound && !before.currentRound.youHaveSealed && before.currentRound.phase === "open for offers") {
    return { status: 200, body: { ...first.body, changed: `Round ${before.currentRound.round} is open and you have not sealed an offer for it yet.` } };
  }
  const until = Date.now() + seconds * 1000;
  let latest = first;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    latest = await ask();
    if (latest.status !== 200) return latest;
    const moved = change(before, latest.body as Status);
    if (moved) return { status: 200, body: { ...latest.body, changed: moved } };
  }
  return { status: 200, body: { ...latest.body, changed: `Nothing has changed in ${seconds} seconds. Call wait_for_next_round again.` } };
}

async function callTool(name: string, args: Record<string, unknown>, tables: TableDirectory): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  if (name === "wait_for_next_round") {
    const id = tableOf(args.token);
    if (!id || isInvite(args.token)) return refuse("That is not a token: pass your token, starting tok_.");
    const seconds = typeof args.maxSeconds === "number" && Number.isFinite(args.maxSeconds) ? Math.max(1, Math.min(WAIT_MAX, Math.floor(args.maxSeconds))) : WAIT_DEFAULT;
    const reply = await waitForChange(id, args.token, seconds, tables);
    if (reply.status !== 200) return refuse(`Refused: ${String(reply.body.error ?? `status ${reply.status}`)}`);
    addLinks(reply.body, tables);
    return answer(name, reply.body, tables);
  }
  const routes: Record<string, { table: () => string | undefined; path: string }> = {
    start_negotiation: { table: () => newTableId(), path: "/create" },
    join_negotiation: { table: () => tableOf(args.invite), path: "/join" },
    negotiation_status: { table: () => tableOf(args.token), path: "/status" },
    make_offer: { table: () => tableOf(args.token), path: "/offer" },
    leave_negotiation: { table: () => tableOf(args.token), path: "/leave" },
  };
  const route = routes[name];
  if (!route) return refuse(`No tool called ${name}.`);
  const missing = missingSettings(name, args);
  if (missing.length) return refuse(`Not yet: ask your user for ${listOf(missing)}, then call ${name} again. Do not choose these yourself.`);
  // The invite and the token look alike only in length: say which was passed where.
  if (name === "join_negotiation" && typeof args.invite === "string" && args.invite.startsWith("tok_")) return refuse("That is a token, which is secret, not an invite. Ask for the invite: it starts inv_.");
  if (name !== "join_negotiation" && name !== "start_negotiation" && isInvite(args.token)) return refuse("That is the invite. Pass your token, starting tok_.");
  const id = route.table();
  if (!id) return refuse(name === "join_negotiation" ? "That is not an invite: it should start inv_." : "That is not a token: it should start tok_.");
  const reply = await tables.call(id, "POST", route.path, name === "start_negotiation" ? { ...args, tableId: id } : args);
  const body = (reply.body ?? {}) as Record<string, unknown>;
  if (reply.status !== 200) return refuse(`Refused: ${String(body.error ?? `status ${reply.status}`)}`);
  addLinks(body, tables);
  return answer(name, body, tables);
}

/** Answer one JSON-RPC message, or undefined for a notification or a response. */
export async function handleMcpMessage(message: Message, tables: TableDirectory): Promise<unknown> {
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
        return result(id, await callTool(name, args, tables));
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
export async function handleMcpHttp(method: string, headers: { get(name: string): string | null }, readBody: () => Promise<string>, tables: TableDirectory, allowOrigin: (origin: string) => boolean = () => true): Promise<{ status: number; headers: Record<string, string>; body: string }> {
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
  const replies = (await Promise.all(messages.map((m) => handleMcpMessage(m, tables)))).filter((r) => r !== undefined);
  if (replies.length === 0) return { status: 202, headers: CORS, body: "" };
  return { status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(Array.isArray(parsed) ? replies : replies[0]) };
}
