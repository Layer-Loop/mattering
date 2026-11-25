/**
 * A language model as the mind of a bidding agent, through the Claude API.
 *
 * The model is asked for two things: an amount and a short rationale. Its
 * answer is treated as untrusted input (see `acceptDecision`), and if the call
 * fails for any reason the agent's script decides instead.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Decider } from "./agents.ts";

export const DEFAULT_MODEL = "claude-haiku-5-5";

/** A model id as people read it: "claude-haiku-5-5" becomes "Claude Haiku 5.5". */
export function modelLabel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (!match) return model;
  const [, family, major, minor] = match;
  return `Claude ${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}
/** Models for which the API can retry a declined request on another model. */
const WITH_FALLBACK = /^claude-(opus-5|sonnet-5-5|fable-5)/;

export interface ClaudeOptions {
  apiKey: string;
  /** Defaults to DEFAULT_MODEL. */
  model?: string;
  /** Milliseconds allowed for one decision. */
  timeoutMs?: number;
  /** For tests: an API endpoint other than the real one. */
  baseURL?: string;
}

export function claudeDecider(options: ClaudeOptions): Decider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs ?? 12_000,
    maxRetries: 1,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  const model = options.model ?? DEFAULT_MODEL;
  const pounds = (amount: number): string => "£" + amount.toLocaleString("en-GB");

  return async (agent, slot, ceiling) => {
    try {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        ...(WITH_FALLBACK.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                bid: { type: "integer", description: "The bid, in whole pounds." },
                rationale: { type: "string", description: "One or two sentences, first person plural." },
              },
              required: ["bid", "rationale"],
              additionalProperties: false,
            },
          },
        },
        system:
          `You are the bidding agent for ${agent.name}, ${agent.persona}\n\n` +
          "You are taking part in a sealed-bid, first-price auction. Each bidder submits one bid. Nobody sees any bid until all of them are opened together. " +
          "The highest bid wins and pays exactly what it bid. A bid cannot be changed or withdrawn once it is sealed.",
        messages: [
          {
            role: "user",
            content:
              `The lot: ${slot.title}. ${slot.detail}\n` +
              `Bids must be a whole number of pounds from ${pounds(slot.minBid)} to ${pounds(slot.maxBid)}.\n` +
              `The most ${agent.name} is willing to pay for this lot is ${pounds(ceiling)}. Two other companies are bidding, and you know nothing about their budgets.\n\n` +
              "Decide what to bid. Then write a rationale of one or two short sentences, in the first person plural, saying why you bid that amount and what you expect to happen. " +
              "The rationale is sealed with the bid and published when the bids open, so write it for that audience.",
          },
        ],
      });
      if (response.stop_reason === "refusal") throw new Error("the model declined");
      const text = response.content.find((block) => block.type === "text");
      if (!text || text.type !== "text") throw new Error("the model returned no text");
      const parsed = JSON.parse(text.text) as { bid?: unknown; rationale?: unknown };
      return { bid: parsed.bid, prediction: parsed.rationale };
    } catch (error) {
      // Say why in the log, most specific first; the caller falls back to the script either way.
      if (error instanceof Anthropic.AuthenticationError) console.error("language model: the API key was rejected");
      else if (error instanceof Anthropic.RateLimitError) console.error("language model: rate limited");
      else if (error instanceof Anthropic.APIConnectionError) console.error("language model: could not connect, or timed out");
      else if (error instanceof Anthropic.APIError) console.error(`language model: API error ${error.status}: ${error.message}`);
      else console.error(`language model: ${(error as Error).message}`);
      throw error;
    }
  };
}

// --- negotiating agents --------------------------------------------------------

/** What a negotiating agent is told before one step. Its limit is its own firm's secret. */
export interface OfferAsk {
  side: "buyer" | "seller";
  organisation: string;
  role: string;
  item: string;
  minPrice: number;
  maxPrice: number;
  /** The face value of the invoice, paid in full if no deal is reached. */
  faceValue: number;
  step: number;
  maxSteps: number;
  /** The most this agent may pay (buyer) or the least it may accept (seller). */
  limit: number;
  /** Earlier steps, as both sides saw them once each step opened. */
  history: { step: number; mine: number; theirs: number }[];
}

/** Ask the model for one offer. Resolves to its raw answer, to be checked by `acceptOffer`. */
export type OfferDecider = (ask: OfferAsk) => Promise<unknown>;

/**
 * The amounts an agent may mention in its note: the ones it has actually seen
 * (every opened offer, both sides), its own limit, the deal's fixed figures,
 * and the offer it is making now. Never the other side's current offer, which
 * is sealed.
 */
export function knownAmounts(ask: OfferAsk, offer: number): Set<number> {
  return new Set([ask.limit, ask.faceValue, ask.minPrice, ask.maxPrice, offer, ...ask.history.flatMap((h) => [h.mine, h.theirs])]);
}

/** Every amount of money a note states: £9,400, 9400, £9.4k, 9,400.00. Small numbers (steps, percentages) are not money here. */
export function amountsIn(note: string): number[] {
  const out: number[] = [];
  for (const match of note.matchAll(/£?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k)?\b/gi)) {
    const whole = Number(match[1]!.replace(/,/g, ""));
    const value = match[3] ? Math.round(Number(`${whole}${match[2] ?? ""}`) * 1000) : whole;
    if (value >= 1000) out.push(value);
  }
  return out;
}

export interface AcceptedOffer {
  offer: number;
  /** The agent's note, if it mentions only amounts it has seen. */
  note?: string;
  /** True when the note was dropped for stating an amount the agent could not have seen. */
  noteWithheld?: boolean;
}

/**
 * Accept a model's offer only if it is a whole amount in range and within the
 * agent's mandate. Anything else and the script decides: the mandate binds a
 * model's offers exactly as it binds the script's. The note is kept only if
 * every amount it states is one the agent has seen: a note that names a price
 * the agent could not know, such as the other side's sealed offer, is
 * withheld, whatever the model meant by it.
 */
export function acceptOffer(ask: OfferAsk, value: unknown): AcceptedOffer | undefined {
  const v = value as { offer?: unknown; note?: unknown } | null;
  if (v === null || typeof v !== "object" || typeof v.offer !== "number" || !Number.isSafeInteger(v.offer)) return undefined;
  if (v.offer < ask.minPrice || v.offer > ask.maxPrice) return undefined;
  if (ask.side === "buyer" ? v.offer > ask.limit : v.offer < ask.limit) return undefined;
  const note = typeof v.note === "string" ? v.note.replace(/\s+/g, " ").trim().slice(0, 280) : "";
  if (note === "") return { offer: v.offer };
  const known = knownAmounts(ask, v.offer);
  if (amountsIn(note).some((amount) => !known.has(amount))) return { offer: v.offer, noteWithheld: true };
  return { offer: v.offer, note };
}

export function claudeNegotiator(options: ClaudeOptions): OfferDecider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs ?? 12_000,
    maxRetries: 1,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  const model = options.model ?? DEFAULT_MODEL;
  const pounds = (amount: number): string => "£" + amount.toLocaleString("en-GB");

  return async (ask) => {
    const buyer = ask.side === "buyer";
    const last = ask.step === ask.maxSteps;
    // Every price this agent has actually seen, step by step: all it may know about the other side.
    const history = ask.history.length === 0
      ? "Prices seen so far: none. This is the first step, and nothing has been offered yet."
      : "Prices seen so far (both offers of each step, opened once the step closed):\n" +
        ask.history.map((h) => `- Step ${h.step}: you offered ${pounds(h.mine)}; the other side offered ${pounds(h.theirs)}. They did not cross.`).join("\n");
    try {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        ...(WITH_FALLBACK.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                offer: { type: "integer", description: "This step's offer, in whole pounds." },
                note: { type: "string", description: "One short sentence to your firm explaining the offer. Mention only prices listed as seen, your limit, and this offer." },
              },
              required: ["offer", "note"],
              additionalProperties: false,
            },
          },
        },
        system:
          `You are the negotiating agent for ${ask.organisation}. ${ask.role}.\n\n` +
          `You are negotiating: ${ask.item}. ` +
          (buyer ? "You pay; you want to pay as little as you can. " : "You are paid; you want to receive as much as you can. ") +
          `If no deal is reached, the invoice is simply paid in full (${pounds(ask.faceValue)}) when due.\n\n` +
          "How it works: in each step both sides seal one offer at the same time. Neither side can see the other's offer until both are opened together, and an offer cannot be changed once sealed. " +
          `If the buyer's offer is at least the seller's, the deal is done at the midpoint of the two. Otherwise both offers are revealed and the next step begins, up to ${ask.maxSteps} steps; after the last step there is no deal.\n\n` +
          (buyer
            ? `Your firm's mandate lets you pay at most ${pounds(ask.limit)}. Never offer more. The other side cannot see this limit. `
            : `Your firm's mandate lets you accept no less than ${pounds(ask.limit)}. Never ask for less. The other side cannot see this limit. `) +
          "Your firm counts any deal within the mandate as better than no deal.\n\n" +
          "What you know about the other side is only the offers listed as seen. Its offer for the current step is sealed: you cannot know it, so never describe, guess or imply it, nor say how the other side has moved this step. " +
          "In your note, mention only prices you have been shown as seen, your own limit, and the offer you are making now.",
        messages: [
          {
            role: "user",
            content:
              `${history}\n\nThis is step ${ask.step} of ${ask.maxSteps}. ` +
              (last
                ? `It is the last step: if the two offers do not cross now, there is no deal at all, and ${buyer ? `your firm pays ${pounds(ask.faceValue)} when the invoice is due` : `your firm waits for ${pounds(ask.faceValue)} until the invoice is due`}. A deal at any price within your mandate is better for your firm than that. `
                : "") +
              `Offers must be whole pounds from ${pounds(ask.minPrice)} to ${pounds(ask.maxPrice)}. ` +
              "Decide your offer for this step, and write one short sentence to your firm explaining it.",
          },
        ],
      });
      if (response.stop_reason === "refusal") throw new Error("the model declined");
      const text = response.content.find((block) => block.type === "text");
      if (!text || text.type !== "text") throw new Error("the model returned no text");
      return JSON.parse(text.text) as unknown;
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) console.error("language model: the API key was rejected");
      else if (error instanceof Anthropic.RateLimitError) console.error("language model: rate limited");
      else if (error instanceof Anthropic.APIConnectionError) console.error("language model: could not connect, or timed out");
      else if (error instanceof Anthropic.APIError) console.error(`language model: API error ${error.status}: ${error.message}`);
      else console.error(`language model: ${(error as Error).message}`);
      throw error;
    }
  };
}
