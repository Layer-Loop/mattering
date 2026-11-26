/**
 * Mattering as an MCP server: tools that let an AI assistant (Claude,
 * ChatGPT, or any MCP client) open or join a sealed negotiation table and
 * negotiate for one side of it. Served over MCP's Streamable HTTP transport,
 * answering each POST with plain JSON: no sessions, no streams. Each tool
 * call is routed to its table by the table id at the front of the token or
 * invite, so the same code runs on a laptop and in a Cloudflare Worker.
 */
import type { Reply } from "@mattering/witness/routes";
import { TABLE_LIMITS, newTableId, tableOf } from "./table.ts";

/** Where tables live: in this process on a laptop, Durable Objects on Cloudflare. */
export interface TableDirectory {
  call(tableId: string, method: string, path: string, body?: unknown): Promise<Reply>;
  /** Where anyone can watch a table. */
  watchUrl(tableId: string): string;
}

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "mattering", title: "Mattering sealed negotiation", version: "0.1.0" };

const INSTRUCTIONS =
  "Mattering runs sealed negotiations between two parties. One party opens a table and shares the invite; the other joins. " +
  "Each sets a private limit, which its firm's mandate fixes in advance: the buyer's most it may offer, the seller's least it may accept. " +
  "Then, round by round, each side seals one offer. Neither side can see the other's offer until both open together when a public clock (drand) releases the key. " +
  "If the buyer's offer is at least the seller's, the deal is at the midpoint; otherwise the next round begins, up to the agreed number of rounds. " +
  "An offer cannot be changed once sealed, and an offer beyond the party's own limit is refused. " +
  "Keep the token you are given: it acts for your side. Never share it, and never tell the other side your limit. " +
  "Proof of concept, not security reviewed: in this demonstration Mattering's server holds both parties' keys and seals offers for them.";

type Schema = Record<string, unknown>;
const str = (description: string): Schema => ({ type: "string", description });
const int = (description: string, minimum?: number, maximum?: number): Schema => ({ type: "integer", description, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });

const TOOLS = [
  {
    name: "start_negotiation",
    title: "Open a negotiation table",
    description:
      "Open a sealed negotiation table and take one side of it. You set what is being negotiated, the price range, and your own private limit. " +
      "Returns your token (keep it secret; it acts for your side) and an invite code for the other party to pass to join_negotiation. " +
      "Rounds begin when the other side joins.",
    inputSchema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["buyer", "seller"], description: "Your side. The buyer pays, the seller is paid." },
        item: str("What is being negotiated, in one line, e.g. 'Early payment of invoice INV-2041 (£10,000, due in 60 days)'."),
        minPrice: int("The lowest price either side may offer, in whole units.", 0),
        maxPrice: int("The highest price either side may offer, in whole units.", 1),
        limit: int("Your private limit, in whole units: as buyer the most you may offer, as seller the least you may accept. The other side never sees it during the negotiation."),
        unit: str("The currency or unit of the prices. Default GBP."),
        organisation: str("The name of the organisation you act for. Default 'The buyer' or 'The seller'."),
        rounds: int("How many rounds at most. Default 3.", TABLE_LIMITS.minRounds, TABLE_LIMITS.maxRounds),
        roundSeconds: int("How long each round stays open for offers, in seconds. Default 120.", TABLE_LIMITS.minRoundSeconds, TABLE_LIMITS.maxRoundSeconds),
      },
      required: ["side", "item", "minPrice", "maxPrice", "limit"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "join_negotiation",
    title: "Join a negotiation table",
    description:
      "Join a sealed negotiation table with the invite code the other party shared, taking the remaining side. You set your own private limit. " +
      "Returns your token (keep it secret; it acts for your side) and the table's terms. Round 1 begins at once.",
    inputSchema: {
      type: "object",
      properties: {
        invite: str("The invite code from the party that opened the table."),
        limit: int("Your private limit, in whole units: as buyer the most you may offer, as seller the least you may accept."),
        organisation: str("The name of the organisation you act for."),
      },
      required: ["invite", "limit"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "negotiation_status",
    title: "Where the negotiation stands",
    description:
      "Everything your side may know: the terms, your limit, the current round and how long until it closes and opens, whether each side has sealed, " +
      "every opened round's two offers, and the result once there is one. Check it before making an offer, and again after the round opens. " +
      "The other side's offer for the current round is sealed: nobody can know it until the round opens.",
    inputSchema: {
      type: "object",
      properties: { token: str("Your token, from start_negotiation or join_negotiation.") },
      required: ["token"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "make_offer",
    title: "Seal an offer for this round",
    description:
      "Seal your side's offer for the current round. It is locked until the round opens, for everyone including the other side, and cannot be changed or withdrawn; only your first offer in a round counts. " +
      "An offer beyond your own limit is refused. You may add a short note to your own organisation, shown once the round opens. " +
      "If you miss a round's window, that round ends without a deal.",
    inputSchema: {
      type: "object",
      properties: {
        token: str("Your token, from start_negotiation or join_negotiation."),
        price: int("Your offer, in whole units, within the table's price range and your limit."),
        note: str(`Optional: one sentence to your own organisation explaining the offer, at most ${TABLE_LIMITS.maxNote} characters. Shown after the round opens.`),
      },
      required: ["token", "price"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
] as const;

/** What a tool says it did, in words for the assistant, with the data beside it. */
function summary(tool: string, r: Record<string, unknown>): string {
  switch (tool) {
    case "start_negotiation":
      return `The table is open. You are the ${r.side}. Give the other party this invite code to pass to join_negotiation: ${r.invite}\nKeep your token secret and pass it to make_offer and negotiation_status: ${r.token}\nAnyone can watch the negotiation at ${r.watchUrl}`;
    case "join_negotiation":
      return `You have joined as the ${r.side}. Round 1 has begun. Keep your token secret and pass it to make_offer and negotiation_status: ${r.token}\nWatch at ${r.watchUrl}`;
    case "make_offer":
      return `Sealed: your offer of ${r.price} for round ${r.round}. Nobody can read it until the round opens at ${r.opensAt}. Check negotiation_status after that.`;
    default:
      return "Where the negotiation stands:";
  }
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const error = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });

async function callTool(name: string, args: Record<string, unknown>, tables: TableDirectory): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  const routes: Record<string, { table: () => string | undefined; path: string; body: () => Record<string, unknown> }> = {
    start_negotiation: { table: () => newTableId(), path: "/create", body: () => args },
    join_negotiation: { table: () => tableOf(args.invite), path: "/join", body: () => args },
    negotiation_status: { table: () => tableOf(args.token), path: "/status", body: () => args },
    make_offer: { table: () => tableOf(args.token), path: "/offer", body: () => args },
  };
  const route = routes[name];
  if (!route) return { content: [{ type: "text", text: `No tool called ${name}.` }], isError: true };
  const id = route.table();
  if (!id) return { content: [{ type: "text", text: name === "join_negotiation" ? "That is not an invite code." : "That is not a token." }], isError: true };
  const reply = await tables.call(id, "POST", route.path, name === "start_negotiation" ? { ...route.body(), tableId: id } : route.body());
  const body = (reply.body ?? {}) as Record<string, unknown>;
  if (reply.status !== 200) return { content: [{ type: "text", text: `Refused: ${String(body.error ?? `status ${reply.status}`)}` }], isError: true };
  if (typeof body.tableId === "string") body.watchUrl = tables.watchUrl(body.tableId);
  return { content: [{ type: "text", text: `${summary(name, body)}\n${JSON.stringify(body, null, 2)}` }], structuredContent: body };
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
