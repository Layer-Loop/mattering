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
  /** Watching a negotiation table run by two parties' own assistants: no Start, and the room base is the table. */
  watch?: boolean;
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

const ROOMS: Record<RoomName, { title: string; description: string; eyebrow: string; purpose: string; mechanic: string; scenario: string; how: string; staged: string; start: string; hint: string; option?: string; doc: string }> = {
  auction: {
    title: "The Sealed Room: a sealed-bid auction · Mattering",
    description: "Watch three software agents bid in a sealed auction where nobody, including us, can read a bid until a public clock publishes the key. Bid yourself, try to cheat, and check the result in your own browser.",
    eyebrow: "The Sealed Room · an auction",
    purpose: "Three companies’ agents bid for an advertising package.",
    mechanic: "Every bid is sealed until a public clock opens them all at once. The highest bid wins.",
    scenario: "The package is 12 weeks of spring airtime, and bids run from £400,000 to £800,000. You can bid too.",
    how: "Not even we can open a bid early. When the time comes, your browser counts the bids itself.",
    staged: "The companies are invented. We run the auction’s log and, until independent witnesses join, its cosigner.",
    start: "Start the auction",
    hint: 'About 45 seconds. Bids are chosen by <span data-decider>a language model</span>.',
    doc: "showcase",
  },
  negotiation: {
    title: "The Negotiation Room: an early-payment negotiation · Mattering",
    description: "Watch two firms' software agents agree a price for paying an invoice early. Each round both offers stay sealed until they open together, each agent under a limit the other cannot see. Try to cheat, and check every round in your own browser.",
    eyebrow: "The Negotiation Room · a negotiation",
    purpose: "Two firms’ agents agree a price for paying an invoice early.",
    mechanic: "Each round, both offers are sealed until a public clock opens them together. If they cross, they meet in the middle.",
    scenario: "Acme pays Bolt’s £10,000 invoice today instead of in 60 days, at a discount. Each agent has a limit, set by its firm, that the other can’t see. Up to three rounds.",
    how: "Neither agent can see the other’s offer before making its own. Your browser checks every round.",
    staged: "The firms are invented. Both agents run on our server, so we hold both firms’ keys.",
    start: "Start the negotiation",
    hint: 'Up to 75 seconds. Offers are chosen by <span data-decider>a language model</span>.',
    option: "Let Acme’s agent ignore its limit in the last round",
    doc: "negotiation-room",
  },
};

/** One room: a card that shows the intro, then the live conversation, then the result. The script fills in the last two. */
export function roomPage(room: RoomName, o: PageOptions): string {
  if (o.watch) return watchPage(o);
  const r = ROOMS[room];
  const attrs = ` data-room="${room}"${o.roomBase ? ` data-room-base="${o.roomBase}"` : ""}`;
  const tab = (name: RoomName, label: string) => `<li><a href="${o.paths[name]}"${name === room ? ' aria-current="page"' : ""}>${label}</a></li>`;
  return `${head(o, r.title, r.description, attrs)}
${siteHeader(o, true)}
<main class="page room">
<nav class="tabs" aria-label="Demos"><ul>${tab("auction", "Auction")}${tab("negotiation", "Negotiation")}</ul></nav>
<header class="reminder"><p class="eyebrow">${r.eyebrow}</p><h1>${r.purpose}</h1><p>${r.mechanic}</p></header>
<div class="card">
<section id="s-intro" class="screen" aria-label="About this demo">
<p class="lead">${r.scenario}</p>
<p class="how">${r.how}</p>
<div class="start-row">
<button id="start" class="primary" type="button" data-action="start">${r.start}</button>
<p id="start-hint" class="hint">${r.hint}</p>
</div>
${r.option ? `<details class="options"><summary>Options</summary><label class="option"><input id="rogue" type="checkbox"><span>${r.option}</span></label></details>` : ""}
<p id="start-error" class="start-error" role="alert" hidden></p>
<p class="small">${r.staged} <a href="${GITHUB}/blob/main/docs/${r.doc}.md">How it works, in full</a></p>
</section>
<section id="s-live" class="screen" aria-label="Live" hidden></section>
<section id="s-result" class="screen" aria-label="Result" hidden></section>
</div>
</main>
<script type="module" src="${o.script}"></script>
${siteFooter(o)}`;
}

/**
 * Watching a negotiation table, where two parties' own AI assistants make the
 * offers through Mattering's MCP server. The same card as the Negotiation
 * Room, without Start or the cheats: the page polls the table from the start.
 */
function watchPage(o: PageOptions): string {
  const attrs = ` data-room="negotiation" data-watch="1"${o.roomBase ? ` data-room-base="${o.roomBase}"` : ""}`;
  return `${head(o, "A negotiation table · Mattering", "Watch two parties' AI assistants negotiate through Mattering's MCP server: each round both offers stay sealed until a public clock opens them together, and your browser checks every round.", attrs)}
${siteHeader(o, true)}
<main class="page room">
<header class="reminder"><p class="eyebrow">A negotiation table · watching</p><h1>Two parties’ AI assistants negotiate a price.</h1><p>Each round, both offers are sealed until a public clock opens them together. If they cross, they meet in the middle.</p></header>
<div class="card">
<section id="s-intro" class="screen" aria-label="Waiting">
<p class="lead">Waiting for both sides to join the table.</p>
<p class="how">Each party’s own AI assistant opens or joins the table, and makes its offers, through Mattering’s MCP server. This page follows along and checks each round in your browser once it opens.</p>
<p class="small">This is a demonstration: the offers are sealed and recorded for real, but they are not legally binding and no payment is made. The parties name their own organisations, which are not verified. Mattering’s server holds both parties’ keys and seals their offers for them. Anyone with this page’s address sees each round’s offers once the round opens, and the notes and both limits once the negotiation has ended. <a href="${GITHUB}/blob/main/docs/mcp.md">How it works, in full</a></p>
</section>
<section id="s-live" class="screen" aria-label="Live" hidden></section>
<section id="s-result" class="screen" aria-label="Result" hidden></section>
</div>
</main>
<script type="module" src="${o.script}"></script>
${siteFooter(o)}`;
}
