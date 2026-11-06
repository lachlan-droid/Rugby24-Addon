import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { parseArticle, parseListing, parseListingMarkdown, parsePagination } from "../src/parser.js";

const SOURCE = new URL(process.env.RUGBY24_BASE_URL || "https://rugby24.net/");
const PAGE_COUNT = Math.max(Number(process.env.MAX_SOURCE_PAGES || 20), 1);
const USER_AGENT = process.env.USER_AGENT || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const VERSION = process.env.STATIC_VERSION || `0.1.${Math.floor(Date.now() / 1000)}`;
const TOKEN = (process.env.ADDON_TOKEN || "").trim();
const DIST = join(process.cwd(), "static", "dist");
const STREAM_CONCURRENCY = Math.max(Number(process.env.STREAM_CONCURRENCY || 6), 1);
const FIRECRAWL_TIMEOUT_MS = Math.max(Number(process.env.FIRECRAWL_TIMEOUT_MS || 30000), 5000);
const FIRECRAWL_MIN_INTERVAL_MS = Math.max(Number(process.env.FIRECRAWL_MIN_INTERVAL_MS || 6500), 0);
const MAX_ITEMS = Math.max(Number(process.env.MAX_ITEMS || 100), 1);
const EMBED_RESOLVE_LIMIT = Math.max(Number(process.env.EMBED_RESOLVE_LIMIT || 25), 0);

let firecrawlQueue = Promise.resolve();
let firecrawlLastStartedAt = 0;

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
  if (page > 0) url.search = `?=&page${page + 1}=`;
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

function fetchViaJina(url, { richMedia = false } = {}) {
  const source = new URL(url);
  const proxyUrl = `https://r.jina.ai/http://${source.host}${source.pathname}${source.search}`;
  const headers = richMedia ? ["--header", "X-Retain-Media: html", "--header", "X-With-Iframe: true"] : [];
  return new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "--fail", "--silent", "--show-error", "--location", "--compressed",
      "--connect-timeout", "20", "--max-time", "45",
      "--user-agent", USER_AGENT,
      ...headers,
      proxyUrl,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
      reject(new Error(`Jina proxy curl returned ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

function fetchWithBrowser(url) {
  const browser = process.env.BROWSER_BIN || "google-chrome";
  return new Promise((resolve, reject) => {
    const child = spawn(browser, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--dump-dom", "--virtual-time-budget=12000", `--user-agent=${USER_AGENT}`,
      url.href,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && Buffer.concat(stdout).length > 500) return resolve(Buffer.concat(stdout).toString("utf8"));
      reject(new Error(`browser fetch returned ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

async function fetchViaFirecrawl(url, { cacheBust = false } = {}) {
  const apiKey = (process.env.FIRECRAWL_API_KEY || "")
    .replace(/^FIRECRAWL_API_KEY=/i, "")
    .trim();
  const apiUrl = (process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev/v2").replace(/\/$/, "");
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");

  const request = async () => {
    const wait = FIRECRAWL_MIN_INTERVAL_MS - (Date.now() - firecrawlLastStartedAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    firecrawlLastStartedAt = Date.now();

    const requestUrl = new URL(url);
    if (cacheBust) requestUrl.searchParams.set("r24cb", `${VERSION}-${Date.now()}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${apiUrl}/scrape`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: requestUrl.href,
          formats: ["rawHtml"],
          onlyMainContent: false,
          maxAge: 0,
          storeInCache: false,
          parsers: [],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => ({}));
    const body = payload?.data?.rawHtml;
    if (!response.ok || !payload?.success || typeof body !== "string" || body.length <= 500) {
      const detail = payload?.error || payload?.data?.metadata?.error || `HTTP ${response.status}`;
      throw new Error(`Firecrawl scrape failed: ${detail}`);
    }
    return body;
  };

  const result = firecrawlQueue.then(request, request);
  firecrawlQueue = result.catch(() => undefined);
  return result;
}

function looksLikeListing(body) {
  return /full\s+match|match\s+replay|highlights?|replay/i.test(body) &&
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i.test(body);
}

function looksLikePlayer(body) {
  return /hlsManifestUrl|\.m3u8|videoembed|videoEmbed|data-movie-id|<video\b/i.test(body);
}

async function fetchPage(url, { requireListing = false, richMedia = false } = {}) {
  try {
    const body = await fetchWithCurl(url);
    if (!requireListing || looksLikeListing(body) || looksLikePlayer(body)) return { format: "html", body };
    throw new Error("direct response did not contain a usable Rugby24 page");
  } catch (error) {
    console.warn(`Direct source fetch failed for ${url.href}; trying browser fallback: ${error.message}`);
    if (process.env.FIRECRAWL_API_KEY && (requireListing || richMedia)) {
      console.warn(`Using Firecrawl fallback for ${url.href}: ${error.message}`);
      try {
        return { format: "html", body: await fetchViaFirecrawl(url, { cacheBust: requireListing }) };
      } catch (firecrawlError) {
        console.warn(`Firecrawl fetch failed for ${url.href}; trying browser fallback: ${firecrawlError.message}`);
      }
    }
    try {
      const body = await fetchWithBrowser(url);
      const usable = requireListing ? looksLikeListing(body) : (!richMedia || looksLikeListing(body) || looksLikePlayer(body));
      if (usable) return { format: "html", body };
      throw new Error("browser response did not contain a usable Rugby24 page");
    } catch (browserError) {
      if (process.env.FIRECRAWL_API_KEY && richMedia && !requireListing) {
        console.warn(`Browser fetch failed for ${url.href}; using Firecrawl media fallback: ${browserError.message}`);
        try {
          return { format: "html", body: await fetchViaFirecrawl(url) };
        } catch (firecrawlError) {
          console.warn(`Firecrawl fetch failed for ${url.href}; using Jina Reader fallback: ${firecrawlError.message}`);
        }
      }
      console.warn(`Browser fetch failed for ${url.href}; using Jina Reader fallback: ${browserError.message}`);
      return { format: "markdown", body: await fetchViaJina(url, { richMedia }) };
    }
  }
}

function fetchListing(url) {
  return fetchPage(url, { requireListing: true });
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

async function streamFor(item, { resolveEmbeds = true } = {}) {
  try {
    const fetched = await fetchPage(new URL(item.url), { richMedia: true });
    const article = parseArticle(fetched.body, item.url);
    const streams = [];
    if (article.hlsUrl) {
      streams.push({
        name: "Direct HLS stream",
        description: "Direct stream URL extracted from the authorized source player.",
        url: article.hlsUrl,
        behaviorHints: { notWebReady: false },
      });
    }
    if (article.embeds.length) {
      for (const embed of article.embeds) {
        if (resolveEmbeds) {
          try {
            const player = parseArticle((await fetchPage(new URL(embed), { richMedia: true })).body, item.url);
            if (player.hlsUrl) {
              streams.push({
                name: "Direct HLS stream",
                description: "Direct stream URL extracted from the embedded source player.",
                url: player.hlsUrl,
                behaviorHints: { notWebReady: false },
              });
            }
          } catch (embedError) {
            console.warn(`Could not inspect embedded player ${embed}: ${embedError.message}`);
          }
        }

        streams.push({
          name: "Open source player",
          description: "Open the original embedded player when the signed HLS URL is unavailable or expired.",
          externalUrl: embed,
        });
      }
    }
    if (streams.length) return streams;
  } catch (error) {
    console.warn(`Could not resolve a direct stream for ${item.url}: ${error.message}`);
  }

  return [{
    name: "Open source page",
    description: "Open the original Rugby24 page and use its embedded player.",
    externalUrl: item.url,
  }];
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const all = new Map();
const queue = [SOURCE];
const queued = new Set([SOURCE.href]);
const visited = new Set();
while (queue.length && visited.size < PAGE_COUNT) {
  const sourcePage = queue.shift();
  visited.add(sourcePage.href);
  const fetched = await fetchListing(sourcePage);
  const entries = fetched.format === "html"
    ? parseListing(fetched.body, SOURCE.href)
    : parseListingMarkdown(fetched.body, SOURCE.href);
  for (const entry of entries) all.set(entry.url, entry);
  const pagination = fetched.format === "html" ? parsePagination(fetched.body, SOURCE.href) : [];
  for (const link of pagination) {
    if (!queued.has(link.url) && visited.size + queue.length < PAGE_COUNT) {
      queued.add(link.url);
      queue.push(new URL(link.url));
    }
  }
  // Keep working if a proxy omits pagination markup on one page.
  if (!pagination.length && visited.size < PAGE_COUNT) {
    const fallback = pageUrl(visited.size);
    if (!queued.has(fallback.href)) {
      queued.add(fallback.href);
      queue.push(fallback);
    }
  }
  console.log(`Fetched source page ${visited.size}/${PAGE_COUNT}; ${all.size} unique replays`);
}

const items = [...all.values()].sort((a, b) => b.publishedAt - a.publishedAt || a.title.localeCompare(b.title));
if (!items.length) {
  throw new Error("No Rugby24 replay entries were parsed; refusing to publish an empty catalog.");
}
const publishedItems = items.slice(0, MAX_ITEMS);
console.log(`Publishing ${publishedItems.length} newest replays from ${items.length} discovered entries`);
for (const catalog of catalogs) {
  const selected = publishedItems.filter(catalog.test).map((item) => preview(item, catalog.name));
  await writeJson(`catalog/movie/${catalog.id}.json`, { metas: selected });
}

for (let start = 0; start < publishedItems.length; start += STREAM_CONCURRENCY) {
  const batch = publishedItems.slice(start, start + STREAM_CONCURRENCY);
  const resolved = await Promise.all(batch.map(async (item, index) => ({
    item,
    streams: await streamFor(item, { resolveEmbeds: start + index < EMBED_RESOLVE_LIMIT }),
  })));
  for (const { item, streams } of resolved) {
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
      streams,
    });
  }
  console.log(`Resolved streams ${Math.min(start + batch.length, publishedItems.length)}/${publishedItems.length}`);
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

console.log(`Built ${publishedItems.length} replays at ${join(DIST, TOKEN || "<root>")}`);
