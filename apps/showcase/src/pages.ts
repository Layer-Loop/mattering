/**
 * The demo pages as HTML: the way in (`/demo`) and the two rooms. The laptop
 * server serves them and the website build writes them out, so both show the
 * same page. Everything live is drawn by the rooms' script (`web/rooms/`).
 */

export type RoomName = "auction" | "negotiation";

export interface PageOptions {
  /** Where the page's script and stylesheet are served. */
  script: string;
  stylesheet: string;
  /** Hosted: each visitor's room, as a template with "{id}". Absent on a laptop. */
  roomBase?: string;
  /** Prefix for links to the website's own pages: "" on the site, "https://mattering.ai" on a laptop. */
  site: string;
  /** The rooms' own paths. */
  paths: { demos: string; auction: string; negotiation: string };
}

const GITHUB = "https://github.com/Layer-Loop/mattering";
const FONTS = "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=JetBrains+Mono:wght@400;600&display=swap";

const LOGO = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2.5 2"></path><path d="M9 2h6"></path></svg>`;

function head(o: PageOptions, title: string, description: string, extra = ""): string {
  return `<!doctype html>
<html lang="en-GB"${extra}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${o.stylesheet}">
</head>
<body>`;
}

function siteHeader(o: PageOptions, demos: boolean): string {
  return `<header class="site-head"><div class="in">
<div class="brand-row"><a class="brand" href="${o.site}/">${LOGO}<span>Mattering</span></a><span class="poc">Proof of concept · no security review yet</span></div>
<nav class="site-nav" aria-label="Site"><ul>
<li><a href="${o.site}/#how">How it works</a></li>
<li><a href="${GITHUB}/blob/main/docs/protocol.md">Draft standard</a></li>
<li><a href="${o.paths.demos}"${demos ? ' aria-current="page"' : ""}>Demos</a></li>
<li><a href="${GITHUB}">GitHub</a></li>
</ul></nav>
</div></header>`;
}

function siteFooter(o: PageOptions): string {
  return `<footer class="site-foot"><div class="in">
<p>Mattering is an open SDK and draft standard for sealing data until a set time.</p>
<ul><li><a href="${o.site}/#how">How it works</a></li><li><a href="${GITHUB}/blob/main/docs/protocol.md">Draft standard</a></li><li><a href="${GITHUB}">Source on GitHub</a></li></ul>
</div></footer>
</body>
</html>
`;
}

/** The way into the two rooms. */
export function chooserPage(o: PageOptions): string {
  const g = (top: number) => `<i class="g" style="top:${top}px"></i>`;
  const b = (left: string, width: string, top: number) => `<i class="b" style="left:${left};width:${width};top:${top}px"></i>`;
  return `${head(o, "Live demos: the Sealed Room and the Negotiation Room · Mattering", "Two live rooms where software agents seal bids or offers that nobody can open until a public clock says so. Watch, try to cheat, and check the result yourself.")}
${siteHeader(o, true)}
<main class="page chooser">
<div class="chooser-intro">
<h1>Try it before you read about it</h1>
<p>Two live rooms. Software agents seal bids or offers that nobody can open until a public clock says so. You watch, try to cheat, and check the result yourself.</p>
</div>
<div class="doors">
<a class="door" href="${o.paths.auction}">
<div class="door-art" aria-hidden="true">${g(34)}${b("30px", "58%", 30)}${g(66)}${b("70px", "47%", 62)}${g(98)}${b("110px", "37%", 94)}<i class="o" style="right:70px"></i></div>
<div class="door-text"><p class="eyebrow">Auction · about 45 seconds</p><h2>The Sealed Room</h2><p>Three agents bid for an ad package. Every bid stays sealed until the clock runs out. You can bid too.</p><span class="go">Enter the room</span></div>
</a>
<a class="door" href="${o.paths.negotiation}">
<div class="door-art" aria-hidden="true">${g(50)}${b("34px", "18%", 46)}${b("44%", "18%", 46)}${g(96)}${b("42px", "16%", 92)}${b("46%", "16%", 92)}<i class="o" style="left:34%"></i><i class="o" style="left:68%"></i></div>
<div class="door-text"><p class="eyebrow">Negotiation · up to 75 seconds</p><h2>The Negotiation Room</h2><p>Two firms’ agents agree a price for paying an invoice early. Each round, both offers stay sealed until they open together.</p><span class="go">Enter the room</span></div>
</a>
</div>
</main>
${siteFooter(o)}`;
}

const ROOMS: Record<RoomName, { title: string; description: string; h1: string; intro: [string, string][]; more: string[]; start: string; hint: string; option?: string }> = {
  auction: {
    title: "The Sealed Room: a sealed-bid auction · Mattering",
    description: "Watch three software agents bid in a sealed auction where nobody, including us, can read a bid until a public clock publishes the key. Bid yourself, try to cheat, and check the result in your own browser.",
    h1: "The Sealed Room: a sealed-bid auction",
    intro: [
      ["Purpose", "Three agents bid for an ad package. Every bid stays sealed until the clock runs out."],
      ["Scenario", "Invented advertisers bid £400k–£800k for spring airtime. You can bid too. We run the auction log and, until independent witnesses join, its cosigner."],
      ["How it works", "Bids open only when drand publishes the key; your browser counts them."],
    ],
    more: [
      "The lot is a 12-week spring package of TV, streaming and outdoor advertising. Bids run from £400,000 to £800,000, and the highest wins.",
      "Each bid is sealed the moment it is sent and written to a public log. Nobody, including us, can read a bid until drand, a public clock run by independent organisations, publishes the key. Then every bid opens at once and your browser counts them.",
      'The agents’ bids are chosen by <span data-decider>a language model</span>. Yours is chosen by you.',
    ],
    start: "Start the auction",
    hint: 'About 45 seconds. Bids are chosen by <span data-decider>a language model</span>.',
  },
  negotiation: {
    title: "The Negotiation Room: an early-payment negotiation · Mattering",
    description: "Watch two firms' software agents agree a price for paying an invoice early. Each round both offers stay sealed until they open together, each agent under a limit the other cannot see. Try to cheat, and check every round in your own browser.",
    h1: "The Negotiation Room: an early-payment negotiation",
    intro: [
      ["Purpose", "Two firms’ agents agree a price for paying an invoice early."],
      ["Scenario", "Acme settles Bolt’s £10,000 invoice today. Each agent has a hidden limit. Both firms’ agents run on our server for this demo, so we hold both keys."],
      ["How it works", "Each round, both offers open together. If they cross, they meet in the middle."],
    ],
    more: [
      "The invoice is due in 60 days. Offers run from £9,000 to £10,000. Each firm gives its agent a public mandate, signed with the firm’s key, with a hidden limit: what Acme may pay at most, and what Bolt may accept at least.",
      "Each round, both agents seal an offer, and it is written to a public log. The offers are sealed to Acme and Bolt, and open when drand publishes the key. If Acme’s offer is at least Bolt’s price, the deal is at the midpoint. If not, they go again, up to three rounds.",
      'Offers are chosen by <span data-decider>a language model</span>.',
    ],
    start: "Start the negotiation",
    hint: 'Up to 75 seconds. Offers are chosen by <span data-decider>a language model</span>.',
    option: "Let Acme’s agent ignore its limit in the last round",
  },
};

/** One room. The script fills in the live band, the checks and the start row's state. */
export function roomPage(room: RoomName, o: PageOptions): string {
  const r = ROOMS[room];
  const attrs = ` data-room="${room}"${o.roomBase ? ` data-room-base="${o.roomBase}"` : ""}`;
  const tab = (name: RoomName, label: string) => `<li><a href="${o.paths[name]}"${name === room ? ' aria-current="page"' : ""}>${label}</a></li>`;
  return `${head(o, r.title, r.description, attrs)}
${siteHeader(o, true)}
<main class="page">
<section class="about" aria-label="About this demo">
<nav class="tabs" aria-label="Demos"><ul>${tab("auction", "Auction")}${tab("negotiation", "Negotiation")}</ul></nav>
<h1 class="sr">${r.h1}</h1>
<dl class="intro">${r.intro.map(([label, text]) => `<div><dt>${label}</dt><dd>${text}</dd></div>`).join("")}</dl>
<details class="more"><summary>More detail</summary><div class="body">${r.more.map((p) => `<p>${p}</p>`).join("")}</div></details>
<div class="start-row">
<button id="start" class="primary" type="button" data-action="start">${r.start}</button>
<p id="start-hint" class="hint">${r.hint}</p>
${r.option ? `<label class="option"><input id="rogue" type="checkbox"><span>${r.option}</span></label>` : ""}
<p id="start-error" class="start-error" role="alert" hidden></p>
</div>
</section>
<section id="band" class="band" aria-label="${room === "auction" ? "The Sealed Room" : "The Negotiation Room"}, live"></section>
<div id="checks"></div>
<section class="full" aria-labelledby="full-h">
<div><h2 id="full-h">How it works, in full</h2><p>The documentation explains the design in full, and the code is open.</p></div>
<div class="links"><a class="solid" href="${GITHUB}/blob/main/docs/${room === "auction" ? "showcase" : "negotiation-room"}.md">Read the documentation</a><a href="${GITHUB}">See the code on GitHub</a></div>
</section>
</main>
<script type="module" src="${o.script}"></script>
${siteFooter(o)}`;
}
