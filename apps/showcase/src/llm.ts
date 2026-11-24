/**
 * A language model as the mind of a bidding agent, through the Claude API.
 *
 * The model is asked for two things: an amount and a short rationale. Its
 * answer is treated as untrusted input (see `acceptDecision`), and if the call
 * fails for any reason the agent's script decides instead.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Decider } from "./agents.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
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
