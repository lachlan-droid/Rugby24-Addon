import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { parseListing } from "../src/parser.js";

const SOURCE = new URL(process.env.RUGBY24_BASE_URL || "https://rugby24.net/");
const PAGE_COUNT = Math.max(Number(process.env.MAX_SOURCE_PAGES || 20), 1);
const USER_AGENT = process.env.USER_AGENT || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const VERSION = process.env.STATIC_VERSION || `0.1.${Math.floor(Date.now() / 1000)}`;
const TOKEN = (process.env.ADDON_TOKEN || "").trim();
const DIST = join(process.cwd(), "static", "dist");

const catalogs = [
  { id: "rugby24-latest", name: "Latest rugby replays", test: () => true },
  { id: "rugby24-premiership", name: "Premiership Rugby", test: (item) => /prem|premiership/i.test(item.title) },
  { id: "rugby24-top14", name: "Top 14 Rugby", test: (item) => /top\s*14/i.test(item.title) },
  { id: "rugby24-urc", name: "United Rugby Championship", test: (item) => /\burc\b|united rugby/i.test(item.title) },
  { id: "rugby24-champions-cup", name: "Champions Cup", test: (item) => /champions cup/i.test(item.title) },
  { id: "rugby24-six-nations", name: "Six Nations", test: (item) => /six nations/i.test(item.title) },
  { id: "rugby24-internationals", name: "Rugby Internationals", test: (item) => /rugby internationals/i.test(item.title) },
  { id: "rugby24-league", name: "Rugby League", test: (item) => /rugby league|nrl|super league/i.test(item.title) },
];

function pageUrl(page) {
  const url = new URL(SOURCE);
  if (page > 0) url.search = `?page${page + 1}`;
  return url;
}

function fetchWithCurl(url) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "--fail", "--silent", "--show-error", "--location", "--compressed",
      "--connect-timeout", "10", "--max-time", "20",
      "--user-agent", USER_AGENT,
      "--header", "Accept: text/html,application/xhtml+xml",
      "--header", "Accept-Language: en-AU,en;q=0.9",
      "--referer", SOURCE.href,
      url.href,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
      reject(new Error(`curl returned ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

function idFor(item) {
  return `rugby24-${createHash("sha256").update(item.url).digest("hex").slice(0, 16)}`;
}

function preview(item, category) {
  return {
    id: idFor(item),
    type: "movie",
    name: item.title,
    poster: item.poster || undefined,
    description: `${category} — published ${item.publishedAt.toISOString().slice(0, 10)}.`,
    releaseInfo: item.publishedAt.toISOString().slice(0, 10),
    genres: [category],
  };
}

async function writeJson(relativePath, value) {
  const target = join(DIST, TOKEN, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const all = new Map();
for (let page = 0; page < PAGE_COUNT; page += 1) {
  const entries = parseListing(await fetchWithCurl(pageUrl(page)), SOURCE.href);
  for (const entry of entries) all.set(entry.url, entry);
  console.log(`Fetched source page ${page + 1}/${PAGE_COUNT}; ${all.size} unique replays`);
}

const items = [...all.values()].sort((a, b) => b.publishedAt - a.publishedAt || a.title.localeCompare(b.title));
for (const catalog of catalogs) {
  const selected = items.filter(catalog.test).map((item) => preview(item, catalog.name));
  await writeJson(`catalog/movie/${catalog.id}.json`, { metas: selected });
}

for (const item of items) {
  const id = idFor(item);
  const releaseInfo = item.publishedAt.toISOString().slice(0, 10);
  await writeJson(`meta/movie/${id}.json`, {
    meta: {
      id,
      type: "movie",
      name: item.title,
      poster: item.poster || undefined,
      description: `Authorized Rugby24 replay published ${releaseInfo}.`,
      releaseInfo,
      genres: ["Rugby"],
      links: [{ name: "Original source page", category: "movie", url: item.url }],
    },
  });
  await writeJson(`stream/movie/${id}.json`, {
    streams: [{
      name: "Open source page",
      description: "Open the original Rugby24 page and use its embedded player.",
      externalUrl: item.url,
    }],
  });
}

await writeJson("manifest.json", {
  id: "private.rugby24.nuvio.static",
  version: VERSION,
  name: "Private Rugby24 Archive",
  description: "Static, date-ordered catalog of authorized Rugby24 replay pages.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  catalogs: catalogs.map(({ id, name }) => ({ type: "movie", id, name })),
  behaviorHints: { configurable: false, adult: false, p2p: false },
});

console.log(`Built ${items.length} replays at ${join(DIST, TOKEN || "<root>")}`);
