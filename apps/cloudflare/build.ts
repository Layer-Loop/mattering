/**
 * Build the two files the Mattering website needs from this repository:
 *
 *   <site>/src/worker.js                   the Worker and its Durable Object
 *   <site>/public/assets/sealed-room.js    the page's script
 *
 *   npm run build:site -- ../mattering-web
 *
 * The site repository commits these files, so deploying it needs nothing from
 * here. Rebuild and commit there whenever this repository changes.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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
  if (execSync("git status --porcelain", { cwd: here, encoding: "utf8" }).trim()) commit += " (with uncommitted changes)";
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
mkdirSync(join(out, "public", "assets"), { recursive: true });
writeFileSync(join(out, "src", "worker.js"), `${banner}\n${worker.outputFiles[0]!.text}`);
writeFileSync(join(out, "public", "assets", "sealed-room.js"), `${banner}\n${await bundlePage(true)}`);
console.log(`worker:  ${join(out, "src", "worker.js")}  (${Math.round(worker.outputFiles[0]!.text.length / 1024)} KB)`);
console.log(`page:    ${join(out, "public", "assets", "sealed-room.js")}`);
console.log(`source:  ${commit}`);
