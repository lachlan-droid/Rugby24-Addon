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
const SPORTS_REPLAY_MANIFEST = process.env.SPORTS_REPLAY_MANIFEST ||
  "https://sports-replay.michaelrobgrove.workers.dev/stremio/247c929c3684fde3bce7f081eeaf04b5e2d72efbf80e6fe9/manifest.json";
const METADATA_SCOPE = "sports-metadata";
const CATALOG_SCOPE = "sports-catalog";
const PUBLISHED_FALLBACK_BASE = process.env.PUBLISHED_FALLBACK_BASE ||
  `https://lachlan-droid.github.io/Rugby24-Addon/${TOKEN}/`;
const SKIP_LIVE_SOURCE = process.env.SKIP_LIVE_SOURCE === "true";
const SECTION_PATHS = [
  "premiership-rugby",
  "top14",
  "urc",
  "rugby-internationals",
  "champions-cup",
  "challenge-cup",
  "six-nations",
  "super-rugby",
  "rugby-league",
  "nrl",
  "super-league",
  "rugby-league-internationals",
];

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
    if (cacheBust) {
      const originalSearch = requestUrl.search;
      const cacheBustValue = encodeURIComponent(`${VERSION}-${Date.now()}`);
      requestUrl.search = originalSearch
        ? `?r24cb=${cacheBustValue}&${originalSearch.slice(1)}`
        : `?r24cb=${cacheBustValue}`;
    }

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

async function writeScopedJson(scope, relativePath, value) {
  await writeJson(`${scope}/${relativePath}`, value);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function restorePublishedStaticFiles() {
  const manifest = await fetchJson(new URL("manifest.json", PUBLISHED_FALLBACK_BASE).href);
  await writeJson("manifest.json", manifest);
  const metas = [];
  const catalogsToRestore = Array.isArray(manifest.catalogs) ? manifest.catalogs : [];
  for (const catalog of catalogsToRestore) {
    const relativePath = `catalog/movie/${catalog.id}.json`;
    try {
      const catalogData = await fetchJson(new URL(relativePath, PUBLISHED_FALLBACK_BASE).href);
      await writeJson(relativePath, catalogData);
      if (Array.isArray(catalogData?.metas)) metas.push(...catalogData.metas);
    } catch (error) {
      console.warn(`Could not restore fallback catalog ${catalog.id}: ${error.message}`);
    }
  }

  const uniqueMetas = [...new Map(metas.map((meta) => [meta.id, meta])).values()];
  for (const meta of uniqueMetas) {
    for (const resource of ["meta", "stream"]) {
      const relativePath = `${resource}/movie/${encodeURIComponent(meta.id)}.json`;
      try {
        const value = await fetchJson(new URL(relativePath, PUBLISHED_FALLBACK_BASE).href);
        await writeJson(relativePath, value);
      } catch (error) {
        console.warn(`Could not restore fallback ${resource} for ${meta.id}: ${error.message}`);
      }
    }
  }

  return uniqueMetas
    .filter((meta) => meta?.name && meta?.releaseInfo)
    .map((meta) => ({
      title: meta.name,
      poster: meta.poster,
      publishedAt: new Date(meta.releaseInfo),
      url: `fallback:${meta.id}`,
    }));
}

function sourceTeamPair(title) {
  const prefix = String(title || "")
    .replace(/\b(?:french\s+top\s*14|united\s+championship|gallagher\s+premiership|league\s+world\s+cup|hilux\s+npc|european\s+(?:champions|challenge)\s+cup|super\s+rugby|bledisloe\s+cup|download|full\s+match).*/i, "")
    .trim();
  const match = prefix.match(/^(.+?)\s+v(?:s\.?)?\s+(.+)$/i);
  return match ? [match[1], match[2]] : [];
}

function rugbyTeamPair(title) {
  const first = String(title || "").split(/\s+-\s+/)[0].trim();
  const match = first.match(/^(.+?)\s+v(?:s\.?)?\s+(.+)$/i);
  return match ? [match[1], match[2]] : [];
}

function teamTokens(value) {
  return new Set(String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !["the", "club", "rugby", "saints"].includes(token)));
}

function sideSimilarity(left, right) {
  const a = teamTokens(left);
  const b = teamTokens(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / Math.max(Math.min(a.size, b.size), 1);
}

function matchSimilarity(source, replay) {
  const sourceTeams = sourceTeamPair(source.name);
  const replayTeams = rugbyTeamPair(replay.title);
  if (source.releaseInfo !== replay.publishedAt.toISOString().slice(0, 10)) return 0;
  if (sourceTeams.length !== 2 || replayTeams.length !== 2) return 0;
  const ordered = (sideSimilarity(sourceTeams[0], replayTeams[0]) + sideSimilarity(sourceTeams[1], replayTeams[1])) / 2;
  const reversed = (sideSimilarity(sourceTeams[0], replayTeams[1]) + sideSimilarity(sourceTeams[1], replayTeams[0])) / 2;
  return Math.max(ordered, reversed);
}

function cleanMetadataTitle(title) {
  return String(title || "")
    .replace(/\s*-\s*Full Match Replay\s*/i, " — ")
    .replace(/\s+-\s+/g, " — ")
    .replace(/\s*—\s*—\s*/g, " — ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function metadataTags(title) {
  const value = String(title || "");
  return ["Rugby", metadataCategory(value)];
}

function metadataCategory(title) {
  const value = String(title || "");
  if (/top\s*14/i.test(value)) return "Top 14";
  if (/prem|gallagher/i.test(value)) return "Premiership Rugby";
  if (/urc|united rugby/i.test(value)) return "URC";
  if (/champions cup/i.test(value)) return "Champions Cup";
  if (/challenge cup/i.test(value)) return "Challenge Cup";
  if (/six nations/i.test(value)) return "Six Nations";
  if (/super rugby/i.test(value)) return "Super Rugby";
  if (/nrl|super league|league world cup/i.test(value)) return "Rugby League";
  if (/wxv|women/i.test(value)) return "Women's Rugby";
  if (/international|test match|b[o\u00f8]ledisloe|rugby championship|world cup/i.test(value)) return "Internationals";
  return "Rugby Union";
}

async function buildSportsMetadataOverlay(rugbyItems) {
  const catalogUrl = new URL("catalog/movie/rugby.json", SPORTS_REPLAY_MANIFEST).href;
  const source = await fetchJson(catalogUrl);
  const sourceItems = Array.isArray(source?.metas) ? source.metas : [];
  const usedReplays = new Set();
  const entries = [];

  for (const sourceItem of sourceItems) {
    const candidates = rugbyItems
      .filter((item) => !usedReplays.has(item.url))
      .map((item) => ({ item, score: matchSimilarity(sourceItem, item) }))
      .filter(({ score }) => score >= 0.5)
      .sort((a, b) => b.score - a.score);
    const matched = candidates[0]?.item;
    if (matched) usedReplays.add(matched.url);

    const date = sourceItem.releaseInfo || matched?.publishedAt.toISOString().slice(0, 10) || "";
    const title = matched ? cleanMetadataTitle(matched.title) : cleanMetadataTitle(sourceItem.name);
    const tags = metadataTags(matched?.title || sourceItem.name);
    const poster = matched?.poster || sourceItem.poster;
    const meta = {
      id: sourceItem.id,
      type: "movie",
      name: title,
      poster,
      background: poster,
      description: `${title}. Full-match replay published ${date}.`,
      releaseInfo: date,
      runtime: sourceItem.runtime || "2h",
      genre: tags,
      genres: tags,
      behaviorHints: { defaultVideoId: sourceItem.id },
    };
    entries.push({ sourceItem, meta, category: metadataCategory(matched?.title || sourceItem.name) });
    await writeScopedJson(METADATA_SCOPE, `meta/movie/${sourceItem.id}.json`, { meta });
  }

  const catalogDefinitions = [
    ["top14", "Top 14"],
    ["super-rugby", "Super Rugby"],
    ["six-nations", "Six Nations"],
    ["internationals", "Internationals"],
    ["premiership", "Premiership Rugby"],
    ["urc", "URC"],
    ["champions-cup", "Champions Cup"],
    ["challenge-cup", "Challenge Cup"],
    ["rugby-league", "Rugby League"],
    ["womens-rugby", "Women's Rugby"],
    ["rugby-union", "Rugby Union"],
  ];
  const availableCatalogs = [];
  for (const [id, name] of catalogDefinitions) {
    const metas = entries
      .filter((entry) => entry.category === name)
      .sort((a, b) => String(b.meta.releaseInfo || "").localeCompare(String(a.meta.releaseInfo || "")))
      .map((entry) => entry.meta);
    if (metas.length) {
      availableCatalogs.push([id, name]);
      await writeScopedJson(METADATA_SCOPE, `catalog/movie/sports-replay-${id}.json`, { metas });
      await writeScopedJson(CATALOG_SCOPE, `catalog/movie/sports-replay-${id}.json`, { metas });
    }
  }

  await writeScopedJson(METADATA_SCOPE, "manifest.json", {
    id: "private.rugby24.sports-replay.metadata",
    version: VERSION,
    name: "Rugby Replay Metadata",
    description: "Clean rugby titles, competition tags, dates, descriptions, and Rugby24 artwork for the Sports Replay add-on.",
    resources: [
      { name: "catalog", types: ["movie"] },
      { name: "meta", types: ["movie"], idPrefixes: ["sports-replay:"] },
    ],
    types: ["movie"],
    catalogs: availableCatalogs.map(([id, name]) => ({ type: "movie", id: `sports-replay-${id}`, name })),
    behaviorHints: { configurable: false, adult: false, p2p: false },
  });
  await writeScopedJson(CATALOG_SCOPE, "manifest.json", {
    id: "private.rugby24.sports-replay.catalogs",
    version: VERSION,
    name: "Rugby Competition Catalogs",
    description: "Competition rows for Rugby24 replays, with Rugby24 artwork and dates; streams remain provided by the Sports Replay add-on.",
    resources: [{ name: "catalog", types: ["movie"] }],
    types: ["movie"],
    catalogs: availableCatalogs.map(([id, name]) => ({ type: "movie", id: `sports-replay-${id}`, name })),
    behaviorHints: { configurable: false, adult: false, p2p: false },
  });
  console.log(`Built metadata overlay for ${sourceItems.length} Sports Replay items; matched ${usedReplays.size} Rugby24 pages`);
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
const queue = [SOURCE, ...SECTION_PATHS.map((path) => new URL(path, SOURCE))];
const queued = new Set(queue.map((url) => url.href));
const visited = new Set();
while (!SKIP_LIVE_SOURCE && queue.length && visited.size < PAGE_COUNT) {
  const sourcePage = queue.shift();
  visited.add(sourcePage.href);
  let fetched;
  try {
    fetched = await fetchListing(sourcePage);
  } catch (error) {
    console.warn(`Could not fetch listing page ${sourcePage.href}; skipping: ${error.message}`);
    if (/402|credit|quota|balance|payment required/i.test(error.message)) break;
    continue;
  }
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
  console.warn("No Rugby24 pages were available; restoring the last published catalogue without Firecrawl.");
  const fallbackItems = await restorePublishedStaticFiles();
  if (!fallbackItems.length) {
    throw new Error("No Rugby24 replay entries were available from the source or the published fallback.");
  }
  await buildSportsMetadataOverlay(fallbackItems);
  console.log(`Restored ${fallbackItems.length} published Rugby24 entries and rebuilt the metadata overlay`);
  process.exit(0);
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

try {
  await buildSportsMetadataOverlay(publishedItems);
} catch (error) {
  console.warn(`Could not build Sports Replay metadata overlay: ${error.message}`);
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
