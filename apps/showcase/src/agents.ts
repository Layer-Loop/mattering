/**
 * The bidders in the showcase. Each agent has a public description, a private
 * ceiling it draws afresh for every auction, and a scripted way of bidding.
 * When a language model is available it decides the bid instead; the script is
 * what runs when no model is configured, or when the model fails, is slow or
 * returns something unusable. Whatever decides, the result is sealed and
 * checked in exactly the same way.
 */

export interface Slot {
  title: string;
  detail: string;
  minBid: number;
  maxBid: number;
}

export const SLOT: Slot = {
  title: "Exclusive advertising package, one quarter",
  detail: "Exclusive category sponsorship across a national media network for three months.",
  minBid: 100_000,
  maxBid: 1_000_000,
};

export interface Decision {
  /** Whole pounds. */
  bid: number;
  /** Sealed alongside the bid and opened with it. */
  prediction: string;
}

export interface Agent {
  name: string;
  /** Shown on the page. */
  tagline: string;
  /** Given to the language model. */
  persona: string;
  /** Categorical series slot (1 to 3) used for this agent's colour. */
  series: number;
  /** The most this company might be willing to pay, in whole pounds: [low, high]. */
  ceiling: [number, number];
  /** The fallback: bid from the private ceiling without a model. */
  script: (slot: Slot, ceiling: number, random: () => number) => Decision;
}

/** Ask something else (a language model) to decide for an agent. May throw or return junk. */
export type Decider = (agent: Agent, slot: Slot, ceiling: number) => Promise<unknown>;

const round = (amount: number, step = 1000): number => Math.round(amount / step) * step;
const pounds = (amount: number): string => "£" + amount.toLocaleString("en-GB");

export function drawCeiling(agent: Agent, random: () => number): number {
  const [low, high] = agent.ceiling;
  return round(low + random() * (high - low), 5000);
}

/** Longest rationale kept, in characters. */
const MAX_RATIONALE = 320;

/**
 * Accept a decision from outside only if it is a whole number of pounds inside
 * the auction's range with a non-empty rationale. Anything else is discarded
 * and the script decides. This is the only say a model has: an amount and a
 * sentence. It cannot affect any check.
 */
export function acceptDecision(slot: Slot, value: unknown): Decision | undefined {
  const v = value as { bid?: unknown; prediction?: unknown } | null;
  if (v === null || typeof v !== "object") return undefined;
  if (!Number.isSafeInteger(v.bid) || (v.bid as number) < slot.minBid || (v.bid as number) > slot.maxBid) return undefined;
  if (typeof v.prediction !== "string" || !v.prediction.isWellFormed()) return undefined;
  const text = v.prediction.replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  return { bid: v.bid as number, prediction: text.length > MAX_RATIONALE ? text.slice(0, MAX_RATIONALE - 1) + "…" : text };
}

export const AGENTS: Agent[] = [
  {
    name: "Company A",
    tagline: "A market leader planning a major launch this quarter.",
    persona: "a market-leading consumer brand with a major product launch this quarter. Winning this package matters a great deal to the launch, and the budget is generous.",
    series: 1,
    ceiling: [620_000, 900_000],
    script: (_slot, ceiling, random) => {
      const bid = round(ceiling * (0.84 + random() * 0.08));
      return { bid, prediction: `We are bidding ${pounds(bid)} and expect to win. This quarter matters more to us than to anyone else in the room.` };
    },
  },
  {
    name: "Company B",
    tagline: "A returns-led advertiser that bids what the numbers support.",
    persona: "a disciplined, returns-led advertiser. It bids what its forecast return supports and would sooner lose than overpay.",
    series: 2,
    ceiling: [450_000, 720_000],
    script: (_slot, ceiling, random) => {
      const bid = round(ceiling * (0.88 + random() * 0.07));
      return { bid, prediction: `Our forecast return supports ${pounds(bid)} and no more. A bidder buying for brand reasons will probably go higher.` };
    },
  },
  {
    name: "Company C",
    tagline: "A challenger with a smaller budget, hoping for a bargain.",
    persona: "a challenger brand with a much smaller budget than its rivals. It can only win if the others bid cautiously, and it knows that.",
    series: 3,
    ceiling: [160_000, 320_000],
    script: (slot, ceiling, random) => {
      const bid = Math.max(slot.minBid, round(ceiling * (0.78 + random() * 0.12)));
      return { bid, prediction: `A long shot at ${pounds(bid)}. We expect the winning bid to be more than twice ours.` };
    },
  },
];
