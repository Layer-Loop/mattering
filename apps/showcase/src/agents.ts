/**
 * The bidders in the showcase. An agent is a name and a strategy: a function
 * from the public auction terms to a bid and a sealed prediction. The scripted
 * strategies below are deterministic given a random source. A language-model
 * agent is another function of the same shape; whatever it returns is sealed
 * and checked exactly like these.
 */

export interface Slot {
  title: string;
  detail: string;
  minBid: number;
  maxBid: number;
}

export const SLOT: Slot = {
  title: "Homepage banner, one week",
  detail: "The top banner on The Daily Ledger's homepage for seven days. About 2.1 million views.",
  minBid: 500,
  maxBid: 10_000,
};

export interface Decision {
  /** Whole pounds. */
  bid: number;
  /** Sealed alongside the bid and opened with it. */
  prediction: string;
}

export type Strategy = (slot: Slot, random: () => number) => Decision | Promise<Decision>;

export interface Agent {
  name: string;
  tagline: string;
  /** Categorical series slot (1 to 3) used for this agent's colour. */
  series: number;
  strategy: Strategy;
}

const between = (random: () => number, low: number, high: number, step = 10): number =>
  Math.round((low + random() * (high - low)) / step) * step;

export const AGENTS: Agent[] = [
  {
    name: "Northwind Outdoors",
    tagline: "Brand team with a winter range to launch. Wants the slot and has the budget.",
    series: 1,
    strategy: (_slot, random) => {
      const bid = between(random, 6200, 7800);
      return { bid, prediction: `We expect to win at £${bid.toLocaleString("en-GB")}. Nobody else needs this week as much as we do.` };
    },
  },
  {
    name: "Pixel & Pine",
    tagline: "Performance marketer. Bids what the clicks are worth and not a pound more.",
    series: 2,
    strategy: (_slot, random) => {
      const clicks = between(random, 16_000, 23_000, 100);
      const bid = Math.round((clicks * 0.3) / 10) * 10;
      return { bid, prediction: `About ${clicks.toLocaleString("en-GB")} clicks at 30p each makes this worth £${bid.toLocaleString("en-GB")} to us. A brand advertiser will probably pay more.` };
    },
  },
  {
    name: "Bargain Barn",
    tagline: "Opportunist. Bids low and hopes the others stay away.",
    series: 3,
    strategy: (slot, random) => {
      const bid = between(random, slot.minBid + 300, slot.minBid + 1100);
      return { bid, prediction: `A long shot at £${bid.toLocaleString("en-GB")}. The winning bid will be over £6,000.` };
    },
  },
];
