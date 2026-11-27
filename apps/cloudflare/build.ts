/**
 * Build what the Mattering website needs from this repository:
 *
 *   <site>/src/worker.js                     the Worker and its Durable Object
 *   <site>/public/demo.html                  the way into the demos, at /demo
 *   <site>/public/demo/auction.html          the Sealed Room, at /demo/auction
 *   <site>/public/demo/negotiation.html      the Negotiation Room, at /demo/negotiation
 *   <site>/public/demo/table.html            watching a negotiation table, at /demo/table?id=…
 *   <site>/public/assets/rooms.<hash>.js     the rooms' script
 *   <site>/public/assets/rooms.<hash>.css    the demo pages' styles
 *
 *   npm run build:site -- ../mattering
 *
 * The script and stylesheet are named by their content, so a new build never
 * meets an old copy in a browser's cache; older builds' files are removed.
 * The site repository commits all of these, so deploying it needs nothing
 * from here. Rebuild and commit there whenever this repository changes.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chooserPage, roomPage, type PageOptions } from "../showcase/src/pages.ts";
import { fundingPage, rentalPage } from "../showcase/src/scenario-pages.ts";
import { bundlePage } from "../showcase/src/server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const site = process.argv[2];
if (!site) {
  console.error("usage: npm run build:site -- <path to the website repository>");
  process.exit(1);
}
const out = resolve(site);
let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: here, encoding: "utf8" }).trim();
  if (execSync("git status --porcelain --untracked-files=no", { cwd: here, encoding: "utf8" }).trim()) commit += " (with uncommitted changes)";
} catch {
  // not a git checkout
}
const banner = `// Built from the Mattering repository at ${commit}. Do not edit: rebuild with "npm run build:site" there.`;

const worker = await build({
  entryPoints: [join(here, "src", "worker.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  minify: true,
  logLevel: "silent",
  external: ["cloudflare:workers"],
  // tlock-js looks for randomness on `window` and otherwise tries to load
  // Node's crypto module. A Worker has neither, but it does have the same Web
  // Crypto API on its global object, so point `window` there.
  define: { global: "globalThis", window: "globalThis" },
});
mkdirSync(join(out, "src"), { recursive: true });
const assets = join(out, "public", "assets");
mkdirSync(join(out, "public", "demo"), { recursive: true });
mkdirSync(assets, { recursive: true });
writeFileSync(join(out, "src", "worker.js"), `${banner}\n${worker.outputFiles[0]!.text}`);

// The rooms' script and styles, named by content.
const hashed = (name: string, ext: string, text: string): string => `${name}.${createHash("sha256").update(text).digest("hex").slice(0, 10)}.${ext}`;
const script = `${banner}\n${await bundlePage(true, "rooms/rooms.ts")}`;
const styles = `/* ${banner.slice(3)} */\n${readFileSync(join(here, "..", "showcase", "web", "rooms", "rooms.css"), "utf8")}`;
const scriptFile = hashed("rooms", "js", script);
const scenarioScript = `${banner}\n${await bundlePage(true, "scenarios/scenarios.ts")}`;
const scenarioFile = hashed("scenarios", "js", scenarioScript);
const stylesFile = hashed("rooms", "css", styles);
// Earlier builds' files, including the pages' old scripts, go.
for (const file of readdirSync(assets)) {
  if (/^(rooms|scenarios)\.[0-9a-f]{10}\.(js|css)$/.test(file) || ["sealed-room.js", "negotiation-room.js", "negotiation-room.css"].includes(file)) rmSync(join(assets, file));
}
writeFileSync(join(assets, scriptFile), script);
writeFileSync(join(assets, scenarioFile), scenarioScript);
writeFileSync(join(assets, stylesFile), styles);

// The pages. Each visitor's room is at /room/<id>, handled by the Worker.
const pages: PageOptions = { script: `/assets/${scriptFile}`, stylesheet: `/assets/${stylesFile}`, roomBase: "/room/{id}", site: "", paths: { demos: "/demo", auction: "/demo/auction", negotiation: "/demo/negotiation" } };
const stamp = `<!-- ${banner.slice(3)} -->\n`;
const withStamp = (html: string): string => html.replace("\n", `\n${stamp}`);
writeFileSync(join(out, "public", "demo.html"), withStamp(chooserPage(pages)));
writeFileSync(join(out, "public", "demo", "auction.html"), withStamp(roomPage("auction", pages)));
writeFileSync(join(out, "public", "demo", "negotiation.html"), withStamp(roomPage("negotiation", pages)));
// The scenario demos: a rental listing and a funding desk, each in the visitor's room.
const scenarioPages: PageOptions = { ...pages, script: `/assets/${scenarioFile}`, roomBase: "/room/{id}" };
writeFileSync(join(out, "public", "demo", "rental.html"), withStamp(rentalPage(scenarioPages)));
writeFileSync(join(out, "public", "demo", "funding.html"), withStamp(fundingPage(scenarioPages)));
// Watching a negotiation table that two parties' assistants run through MCP: /demo/table?id=<table>.
writeFileSync(join(out, "public", "demo", "table.html"), withStamp(roomPage("negotiation", { ...pages, roomBase: "/table/{table}", watch: true })));
console.log(`worker:  ${join(out, "src", "worker.js")}  (${Math.round(worker.outputFiles[0]!.text.length / 1024)} KB)`);
console.log(`pages:   ${join(out, "public", "demo.html")}, demo/auction.html, demo/negotiation.html`);
console.log(`assets:  ${scriptFile} (${Math.round(script.length / 1024)} KB), ${stylesFile}`);
console.log(`source:  ${commit}`);
