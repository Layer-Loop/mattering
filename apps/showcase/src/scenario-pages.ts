/**
 * The scenario demos' pages: a London rental listing and an invoice-funding
 * desk. Each looks like the real thing, with nobody's branding, and says
 * plainly at the top that it is a demonstration. The offer panel is drawn by
 * the scenarios' script (`web/scenarios/`), which seals the visitor's offer in
 * their own browser with the SDK and checks the result there.
 */
import { GITHUB, head, siteFooter, siteHeader, type PageOptions } from "./pages.ts";

export type ScenarioPageName = "rental" | "funding";

/** A London mansion block, drawn rather than photographed: nothing here is a real building. */
const FACADE = `<svg viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Illustration of a brick mansion block with sash windows" class="photo">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe0ef"/><stop offset="1" stop-color="#eef2f6"/></linearGradient>
<pattern id="brick" width="24" height="12" patternUnits="userSpaceOnUse"><rect width="24" height="12" fill="#a8543c"/><path d="M0 11.5h24M12 0v6M0 6h24M6 6v6M18 6v6" stroke="#93452f" stroke-width="1"/></pattern></defs>
<rect width="640" height="400" fill="url(#sky)"/>
<rect x="70" y="60" width="500" height="320" fill="url(#brick)"/>
<rect x="60" y="48" width="520" height="16" fill="#e9e2d6"/><rect x="60" y="210" width="520" height="8" fill="#e9e2d6"/>
${[0, 1, 2, 3, 4].map((i) => [80, 230].map((y) => `<g transform="translate(${100 + i * 92},${y})"><rect width="56" height="${y === 80 ? 100 : 92}" fill="#f4f1ea"/><rect x="5" y="5" width="46" height="${y === 80 ? 90 : 82}" fill="#2c3e50"/><path d="M28 5v${y === 80 ? 90 : 82}M5 ${y === 80 ? 50 : 46}h46" stroke="#f4f1ea" stroke-width="3"/><rect x="-4" y="${y === 80 ? 100 : 92}" width="64" height="6" fill="#e9e2d6"/></g>`).join("")).join("")}
<rect x="286" y="300" width="68" height="80" fill="#1d3b2f"/><circle cx="342" cy="342" r="3" fill="#d9b44a"/><path d="M280 300h80" stroke="#e9e2d6" stroke-width="8"/>
<path d="M70 380h500" stroke="#55585f" stroke-width="4"/>${Array.from({ length: 22 }, (_, i) => `<path d="M${84 + i * 22} 380v-26" stroke="#2b2d33" stroke-width="2"/>`).join("")}<path d="M80 356h480" stroke="#2b2d33" stroke-width="2"/>
<rect x="590" y="250" width="14" height="130" fill="#6b4f36"/><circle cx="597" cy="230" r="42" fill="#5f8f5a"/><circle cx="575" cy="252" r="26" fill="#6e9e66"/>
</svg>`;

const FLOORPLAN = `<svg viewBox="0 0 420 300" role="img" aria-label="Floor plan: open-plan living and kitchen, two bedrooms, a bathroom and a hall, 64 square metres" class="plan">
<rect x="10" y="10" width="400" height="280" fill="#fff" stroke="#15173A" stroke-width="4"/>
<path d="M10 150h170M180 10v280M180 190h90M270 190v100M270 120h140" stroke="#15173A" stroke-width="3" fill="none"/>
<path d="M60 150v-1M130 150h20" stroke="#fff" stroke-width="5"/><path d="M180 60v30M200 190h30M270 230v28M300 120h40" stroke="#fff" stroke-width="5"/>
<g font-family="Atkinson Hyperlegible, sans-serif" fill="#15173A" text-anchor="middle">
<text x="95" y="75" font-size="15" font-weight="700">Bedroom 1</text><text x="95" y="95" font-size="12">3.8 × 3.2 m</text>
<text x="95" y="215" font-size="15" font-weight="700">Bedroom 2</text><text x="95" y="235" font-size="12">3.0 × 2.6 m</text>
<text x="295" y="60" font-size="15" font-weight="700">Living / kitchen</text><text x="295" y="80" font-size="12">6.1 × 4.2 m</text>
<text x="225" y="245" font-size="15" font-weight="700">Bath</text><text x="340" y="215" font-size="15" font-weight="700">Hall</text>
</g></svg>`;

const STREET = `<svg viewBox="0 0 420 300" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Illustration of a tree-lined street" class="plan street">
<rect width="420" height="300" fill="#dfe8ee"/><rect y="190" width="420" height="110" fill="#8b8f96"/><rect y="186" width="420" height="10" fill="#c6c1b6"/>
<path d="M0 250h420" stroke="#f1f1f1" stroke-width="4" stroke-dasharray="26 18"/>
${[40, 150, 260, 370].map((x) => `<rect x="${x - 5}" y="120" width="10" height="70" fill="#6b4f36"/><circle cx="${x}" cy="105" r="36" fill="#6e9e66"/>`).join("")}
<rect x="70" y="40" width="110" height="146" fill="#b56a4f"/><rect x="230" y="60" width="120" height="126" fill="#c98a5c"/>
</svg>`;

function scenarioShell(o: PageOptions, name: ScenarioPageName, title: string, description: string, body: string): string {
  const attrs = ` data-scenario="${name}"${o.roomBase ? ` data-room-base="${o.roomBase}"` : ""}`;
  return `${head(o, title, description, attrs)}
${siteHeader(o, true)}
<main class="page scenario ${name}">
<p class="demo-banner" role="note"><strong>Demonstration.</strong> ${name === "rental" ? "This flat, the letting agent and the other applicants are invented. No tenancy is offered and no money changes hands." : "This invoice, the desk and the other funders are invented. Nothing is funded and no money changes hands."} The offers are sealed for real.</p>
${body}
</main>
<script type="module" src="${o.script}"></script>
${siteFooter(o)}`;
}

/** The offer panel: the script fills it in. */
const panel = (heading: string, intro: string, start: string, offer: string) => `<section class="offer-panel" aria-labelledby="offer-h">
<h2 id="offer-h">${heading}</h2>
<div id="offer" aria-live="polite"><p class="offer-intro">${intro}</p><button class="primary" type="button" data-action="start">${start}</button><p class="hint">About a minute. Your ${offer} is sealed in this browser.</p></div>
</section>`;

export function rentalPage(o: PageOptions): string {
  return scenarioShell(
    o,
    "rental",
    "2 bedroom flat to rent, Larkspur Court, Hackney E8: a sealed-offer demonstration · Mattering",
    "A demonstration rental listing in London: applicants make sealed offers up to the advertised rent, which nobody, the agent included, can read before they all open together. Ties at the full rent are drawn by a public clock anyone can check.",
    `<nav class="crumbs" aria-label="Breadcrumb"><span>To rent</span> › <span>London</span> › <span>Hackney</span></nav>
<div class="listing">
<div class="listing-main">
<div class="gallery">${FACADE}<div class="thumbs">${FLOORPLAN}${STREET}</div></div>
<header class="listing-head"><h1>2 bedroom flat to rent</h1><p class="addr">Larkspur Court, Hackney, London E8</p>
<ul class="chips"><li>2 bedrooms</li><li>1 bathroom</li><li>64 m² · 689 sq ft</li><li>Unfurnished</li><li>EPC C</li></ul></header>
<section class="block"><h2>Key features</h2><ul class="features">
<li>Second-floor flat in a red-brick mansion block</li><li>Open-plan living room and kitchen with dishwasher and washer-dryer</li><li>Two double bedrooms, the main with fitted wardrobes</li><li>Gas central heating and double-glazed sash windows</li><li>Six minutes' walk to Hackney Central station</li><li>Bike store and communal garden</li></ul></section>
<section class="block"><h2>Description</h2><p>A bright two-bedroom flat on a quiet, tree-lined street, close to London Fields and Mare Street. The open-plan living space faces south over the garden; both bedrooms are doubles. Available from 1 February 2027 on a 12-month assured periodic tenancy.</p></section>
<section class="block"><h2>How offers work for this flat</h2><ol class="how-offers">
<li><strong>The advertised rent is the ceiling.</strong> In England the Renters' Rights Act 2025 stops landlords and agents accepting offers above the advertised rent, so offers here run from £2,100 to £2,400 a month, and no higher.</li>
<li><strong>Every offer is sealed</strong> on the applicant's own device until the offers round closes. Then a public clock, drand, opens them all at once: not even the agent can read one early.</li>
<li><strong>The highest offer wins.</strong> If more than one applicant offers the full rent, the public clock's randomness draws one of them, and anyone can check the draw afterwards. Nobody can steer it.</li>
<li><strong>Price is one step.</strong> Referencing, affordability and right-to-rent checks still apply, and the demonstration doesn't cover them. It is not legal advice.</li></ol></section>
</div>
<aside class="listing-side">
<div class="price-card"><p class="price">£2,400 <span>pcm</span></p><p class="pw">£554 pw</p><p class="ceiling">Advertised rent. By law no offer above it can be accepted.</p>
<dl class="facts"><div><dt>Available</dt><dd>1 Feb 2027</dd></div><div><dt>Deposit</dt><dd>£2,769 (5 weeks)</dd></div><div><dt>Holding deposit</dt><dd>£553 (1 week)</dd></div><div><dt>Tenancy</dt><dd>12 months min.</dd></div><div><dt>Council tax</dt><dd>Band C</dd></div></dl>
<p class="agent">Listed by <strong>Demo Lettings</strong>, an invented agent.</p></div>
${panel("Make a sealed offer", "Offers for this flat are taken in one sealed round. Open it, and you and four other applicants (simulated by this demonstration) each make one offer, up to the advertised rent.", "Open the offers round", "offer")}
</aside>
</div>
<p class="small foot-note">The other applicants' offers are chosen by this demonstration. Every offer, yours included, is sealed with Mattering's SDK and submitted through its public API, and your browser checks the result from the evidence. <a href="${GITHUB}/blob/main/docs/scenarios.md">How it works, in full</a></p>`,
  );
}

export function fundingPage(o: PageOptions): string {
  return scenarioShell(
    o,
    "funding",
    "Invoice INV-88213, £250,000: a sealed funding auction demonstration · Mattering",
    "A demonstration invoice-funding desk: funders quote sealed discounts for a £250,000 invoice, the lowest wins, and nobody, the desk included, can read a quote before they all open together.",
    `<nav class="crumbs" aria-label="Breadcrumb"><span>Funding desk</span> › <span>Open auctions</span> › <span>INV-88213</span></nav>
<div class="listing">
<div class="listing-main">
<header class="listing-head"><p class="eyebrow">Receivable · sealed funding auction</p><h1>Invoice INV-88213 · £250,000</h1><p class="addr">Supplier Harrow Supplies Ltd · Debtor Corvane Retail plc</p>
<ul class="chips"><li>Due in 90 days</li><li>Single invoice</li><li>Lowest discount wins</li><li>Reserve 900 bps</li></ul></header>
<section class="block invoice"><h2>The invoice</h2><dl class="facts wide">
<div><dt>Face value</dt><dd>£250,000.00</dd></div><div><dt>Issued</dt><dd>27 Nov 2026</dd></div><div><dt>Due</dt><dd>25 Feb 2027 (90 days)</dd></div>
<div><dt>Supplier</dt><dd>Harrow Supplies Ltd, industrial fasteners</dd></div><div><dt>Debtor</dt><dd>Corvane Retail plc</dd></div><div><dt>Goods</dt><dd>Delivered and accepted 20 Nov 2026</dd></div></dl></section>
<section class="block"><h2>How this auction works</h2><ol class="how-offers">
<li><strong>Funders quote a discount</strong> in basis points of the face value: 700 bps means paying £232,500 today for the £250,000 due in 90 days.</li>
<li><strong>Every quote is sealed</strong> to the desk on the funder's own machine until the auction closes. Then a public clock, drand, releases them all at once: not even the desk can read one early.</li>
<li><strong>The lowest discount wins</strong>, as long as it is within the supplier's reserve of 900 bps; otherwise nothing is funded. Ties are drawn by the public clock's randomness.</li>
<li><strong>Only the desk sees every quote.</strong> Each funder sees the winning quote and its own, and the desk can disclose the rest to an auditor, who can check the result without trusting the desk.</li></ol></section>
</div>
<aside class="listing-side">
<div class="price-card"><p class="price">£250,000 <span>face value</span></p><p class="pw">Reserve 900 bps · £22,500</p><p class="ceiling">The most the supplier will give up to be paid today.</p>
<p class="agent">Run by <strong>Northbank Receivables</strong>, an invented funding desk.</p></div>
${panel("Quote a sealed discount", "Open the auction, and your fund and three other funders (simulated by this demonstration) each quote one discount. The lowest within the reserve funds the invoice.", "Open the auction", "quote")}
</aside>
</div>
<p class="small foot-note">The other funders' quotes are chosen by this demonstration. Every quote, yours included, is sealed with Mattering's SDK and submitted through its public API, and your browser checks the result from the evidence. <a href="${GITHUB}/blob/main/docs/scenarios.md">How it works, in full</a></p>`,
  );
}
