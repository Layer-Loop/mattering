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
  title: "Spring prime-time package: 12 weeks of TV, streaming and outdoor",
  detail: "A 12-week spring package of TV, streaming and outdoor advertising.",
  minBid: 400_000,
  maxBid: 800_000,
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
    tagline: "Coffee-shop chain opening 40 stores",
    persona: "a coffee-shop chain opening 40 stores. It is a disciplined, returns-led advertiser: it bids what its forecast return supports and would sooner lose than overpay.",
    series: 1,
    ceiling: [560_000, 700_000],
    script: (_slot, ceiling, random) => {
      const bid = round(ceiling * (0.88 + random() * 0.07));
      return { bid, prediction: `Our forecast return supports ${pounds(bid)} and no more. A bidder buying for brand reasons will probably go higher.` };
    },
  },
  {
    name: "Company B",
    tagline: "Phone network launching a new plan",
    persona: "a phone network launching a new plan this spring. Winning this package matters a great deal to the launch, and the budget is generous.",
    series: 2,
    ceiling: [640_000, 780_000],
    script: (_slot, ceiling, random) => {
      const bid = round(ceiling * (0.86 + random() * 0.08));
      return { bid, prediction: `We are bidding ${pounds(bid)} and expect to win. This quarter matters more to us than to anyone else in the room.` };
    },
  },
  {
    name: "Company C",
    tagline: "Online travel agent",
    persona: "an online travel agent with a smaller budget than its rivals. It can only win if the others bid cautiously, and it knows that.",
    series: 3,
    ceiling: [470_000, 580_000],
    script: (slot, ceiling, random) => {
      const bid = Math.max(slot.minBid, round(ceiling * (0.88 + random() * 0.08)));
      return { bid, prediction: `A long shot at ${pounds(bid)}. We expect at least one rival to bid well above us.` };
    },
  },
];
