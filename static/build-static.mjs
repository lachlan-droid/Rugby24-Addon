import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const USE_FIRECRAWL = process.env.USE_FIRECRAWL !== "false";
const MAX_ITEMS = Math.max(Number(process.env.MAX_ITEMS || 100), 1);
const MAX_AGE_DAYS = Math.max(Number(process.env.MAX_AGE_DAYS || 180), 1);
const EMBED_RESOLVE_LIMIT = Math.max(Number(process.env.EMBED_RESOLVE_LIMIT || 25), 0);
const SPORTS_REPLAY_MANIFEST = process.env.SPORTS_REPLAY_MANIFEST ||
  "https://sports-replay.michaelrobgrove.workers.dev/stremio/247c929c3684fde3bce7f081eeaf04b5e2d72efbf80e6fe9/manifest.json";
const SPORTSDB_API_BASE = (process.env.SPORTSDB_API_BASE || "https://www.thesportsdb.com/api/v1/json").replace(/\/$/, "");
const SPORTSDB_API_KEY = (process.env.SPORTSDB_API_KEY || "123").trim();
const SPORTSDB_MIN_INTERVAL_MS = Math.max(Number(process.env.SPORTSDB_MIN_INTERVAL_MS || 6500), 0);
const SPORTS_REPLAY_METADATA_CATALOGS = new Set(["rugby"]);
const METADATA_SCOPE = "sports-metadata";
const CATALOG_SCOPE = "sports-catalog";
const SPORTSDB_SCOPE = "sportsdb";
// Keep the full Rugby catalogue. The thumbnail trial can be narrowed independently.
const SPORTSDB_COMPETITION_FILTER = (process.env.SPORTSDB_COMPETITION_FILTER || "").trim().toLowerCase();
const SPORTSDB_THUMBNAIL_FILTER = (process.env.SPORTSDB_THUMBNAIL_FILTER || "").trim().toLowerCase();
const SPORTSDB_THUMBNAIL_RETRY_DAYS = Math.max(Number(process.env.SPORTSDB_THUMBNAIL_RETRY_DAYS || 7), 1);
const SPORTSDB_THUMBNAIL_CACHE_VERSION = "6";
const SPORTSDB_THUMBNAIL_CACHE_FILE = join(process.cwd(), "static", "sportsdb-thumbnails.json");
const PUBLISHED_FALLBACK_BASE = process.env.PUBLISHED_FALLBACK_BASE ||
  `https://lachlan-droid.github.io/Rugby24-Addon/${TOKEN}/`;
const SKIP_LIVE_SOURCE = process.env.SKIP_LIVE_SOURCE === "true";
const ALLOW_PUBLISHED_FALLBACK = process.env.ALLOW_PUBLISHED_FALLBACK !== "false";
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
let sportsDbLastStartedAt = 0;
let sportsDbDayRateLimited = false;
let sportsDbSearchRateLimited = false;
let sportsDbThumbnailCache = {};

async function loadSportsDbThumbnailCache() {
  try {
    const raw = await readFile(SPORTSDB_THUMBNAIL_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) sportsDbThumbnailCache = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Could not read SportsDB thumbnail cache: ${error.message}`);
  }
}

function shouldLookupSportsDbThumbnail(sourceItem) {
  const cached = sportsDbThumbnailCache[sourceItem.id];
  if (!cached) return true;
  if (cached.poster) return false;
  if (cached.lookupVersion !== SPORTSDB_THUMBNAIL_CACHE_VERSION) return true;
  const checkedAt = Date.parse(cached.checkedAt || "");
  if (!Number.isFinite(checkedAt)) return true;
  return Date.now() - checkedAt >= SPORTSDB_THUMBNAIL_RETRY_DAYS * 86400000;
}

async function saveSportsDbThumbnailCache() {
  await writeFile(SPORTSDB_THUMBNAIL_CACHE_FILE, `${JSON.stringify(sportsDbThumbnailCache, null, 2)}\n`);
}

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
    if (USE_FIRECRAWL && process.env.FIRECRAWL_API_KEY && (requireListing || richMedia)) {
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
      if (USE_FIRECRAWL && process.env.FIRECRAWL_API_KEY && richMedia && !requireListing) {
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

function sourceSportForCatalog(catalog) {
  const id = String(catalog.id || "").toLowerCase();
  if (id === "rugby") return "Rugby";
  if (id === "basketball") return "Basketball";
  if (id === "football") return "American Football";
  if (id === "mma") return "Fighting";
  return catalog.name || "Sports";
}

async function sportsReplayMovieItems() {
  const manifest = await fetchJson(SPORTS_REPLAY_MANIFEST);
  const catalogs = (manifest.catalogs || []).filter((catalog) =>
    catalog.type === "movie" && SPORTS_REPLAY_METADATA_CATALOGS.has(catalog.id));
  const items = new Map();
  for (const catalog of catalogs) {
    try {
      const url = new URL(`catalog/movie/${catalog.id}.json`, SPORTS_REPLAY_MANIFEST).href;
      const source = await fetchJson(url);
      for (const item of Array.isArray(source?.metas) ? source.metas : []) {
        if (!item?.id || items.has(item.id)) continue;
        items.set(item.id, {
          ...item,
          sourceCatalogId: catalog.id,
          sourceCatalogName: catalog.name,
          sport: sourceSportForCatalog(catalog),
        });
      }
    } catch (error) {
      console.warn(`Could not load Sports Replay catalogue ${catalog.id}: ${error.message}`);
    }
  }
  return [...items.values()];
}

function replayTeamPair(title) {
  const first = String(title || "").split(/\s+—\s+|\s+-\s+/)[0].trim();
  const match = first.match(/^(.+?)\s+(?:v|vs\.?|at|@)\s+(.+)$/i);
  if (!match) return [];
  const away = match[2]
    .replace(/\s+(?:nations\s+championship|six\s+nations|french\s+top\s*14|top\s*14|gallagher\s+premiership|premiership|united\s+championship|urc|european\s+(?:champions|challenge)\s+cup|league\s+world\s+cup|super\s+rugby|rugby\s+championship|rugby\s+league|download|live|union|league).*$/i, "")
    .trim();
  return [match[1].trim(), away].filter(Boolean);
}

function sportsDbTokens(value) {
  return new Set(String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token && token.length > 1 && !["the", "club", "rugby", "football", "basketball", "league", "union", "download", "live"].includes(token)));
}

const SPORTSDB_TEAM_ALIASES = new Map([
  ["toulouse", "stade toulousain"],
  ["pau", "section paloise"],
  ["northampton", "northampton saints"],
  ["cardiff", "cardiff rugby"],
  ["la rochelle", "stade rochelais"],
  ["clermont auvergne", "asm clermont auvergne"],
  ["clermont", "asm clermont auvergne"],
  ["bordeaux begles", "union bordeaux begles"],
  ["lions", "lions"],
  ["emirates lions", "lions"],
  ["stade francais", "stade francais paris"],
  ["toulon", "rc toulon"],
  ["castres", "castres olympique"],
  ["bayonne", "aviron bayonnais"],
  ["perpignan", "usa perpignan"],
  ["brive", "ca brive"],
  ["bath", "bath rugby"],
  ["benetton treviso", "benetton rugby"],
  ["newcastle", "newcastle falcons"],
  ["exeter", "exeter chiefs"],
  ["leicester", "leicester tigers"],
  ["gloucester", "gloucester rugby"],
  ["bristol", "bristol bears"],
  ["montpellier", "montpellier herault rugby"],
  ["sharks", "sharks"],
  ["the sharks", "sharks"],
  ["dragons", "dragons rugby"],
  ["canterbury", "canterbury rugby"],
  ["northland", "northland rugby"],
  ["taranaki", "taranaki rugby"],
  ["waikato", "waikato rugby"],
  ["north harbour", "north harbour rugby"],
  ["otago", "otago rugby"],
  ["hawkes bay", "hawkes bay rugby"],
  ["edinburgh", "edinburgh rugby"],
  ["glasgow", "glasgow warriors"],
  ["munster", "munster rugby"],
  ["ulster", "ulster rugby"],
  ["connacht", "connacht rugby"],
  ["zebre", "zebre parma"],
  ["leinster", "leinster rugby"],
]);

function sportsDbTeamKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sportsDbTeamTokens(value) {
  const key = sportsDbTeamKey(value);
  return sportsDbTokens(SPORTSDB_TEAM_ALIASES.get(key) || key);
}

function similarToken(left, right) {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function sideSimilarity(left, right) {
  const a = sportsDbTeamTokens(left);
  const b = sportsDbTeamTokens(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => [...b].some((candidate) => similarToken(token, candidate))).length;
  return overlap / Math.max(Math.min(a.size, b.size), 1);
}

function sourceEventSimilarity(sourceItem, event) {
  const sourceDate = String(sourceItem.releaseInfo || "").slice(0, 10);
  const eventDate = String(event.dateEventLocal || event.dateEvent || "").slice(0, 10);
  if (!sourceDate || sourceDate !== eventDate) return 0;
  const sourceTeams = replayTeamPair(sourceItem.name);
  const eventTeams = [event.strHomeTeam, event.strAwayTeam];
  if (sourceTeams.length !== 2 || !eventTeams[0] || !eventTeams[1]) return 0;
  const ordered = (sideSimilarity(sourceTeams[0], eventTeams[0]) + sideSimilarity(sourceTeams[1], eventTeams[1])) / 2;
  const reversed = (sideSimilarity(sourceTeams[0], eventTeams[1]) + sideSimilarity(sourceTeams[1], eventTeams[0])) / 2;
  const teamScore = Math.max(ordered, reversed);
  const leagueScore = sideSimilarity(sourceItem.name, event.strLeague || "");
  return Math.min(teamScore + Math.min(leagueScore * 0.1, 0.1), 1);
}

async function fetchSportsDbEvents(date) {
  if (sportsDbDayRateLimited) return [];
  const wait = SPORTSDB_MIN_INTERVAL_MS - (Date.now() - sportsDbLastStartedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  sportsDbLastStartedAt = Date.now();
  const url = new URL(`${SPORTSDB_API_BASE}/${encodeURIComponent(SPORTSDB_API_KEY)}/eventsday.php`);
  url.searchParams.set("d", date);
  try {
    const response = await fetchJson(url.href);
    return Array.isArray(response?.events) ? response.events : [];
  } catch (error) {
    if (/HTTP 429/.test(error.message)) {
      sportsDbDayRateLimited = true;
      console.warn("SportsDB rate limit reached; using existing Sports Replay metadata for the remaining items. Add a personal API key to increase reliability.");
      return [];
    }
    console.warn(`SportsDB lookup failed for ${date}: ${error.message}`);
    return [];
  }
}

async function fetchSportsDbSearchEvent(sourceItem) {
  if (sportsDbSearchRateLimited) return null;
  const teams = replayTeamPair(sourceItem.name);
  if (teams.length !== 2) return null;
  const sportLabel = /league|nrl|super league/i.test(sourceItem.name) ? "Rugby League" : "Rugby";
  const aliasedTeams = teams.map((team) => SPORTSDB_TEAM_ALIASES.get(sportsDbTeamKey(team)) || team);
  const queries = [...new Set([
    `${teams[0]} vs ${teams[1]}`,
    `${aliasedTeams[0]} vs ${aliasedTeams[1]}`,
    `${teams[0]} ${sportLabel} vs ${teams[1]} ${sportLabel}`,
    `${aliasedTeams[0]} ${sportLabel} vs ${aliasedTeams[1]} ${sportLabel}`,
  ])];
  for (const query of queries) {
    const wait = SPORTSDB_MIN_INTERVAL_MS - (Date.now() - sportsDbLastStartedAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    sportsDbLastStartedAt = Date.now();
    const url = new URL(`${SPORTSDB_API_BASE}/${encodeURIComponent(SPORTSDB_API_KEY)}/searchevents.php`);
    url.searchParams.set("e", query);
    try {
      const response = await fetchJson(url.href);
      const events = Array.isArray(response?.event) ? response.event : [];
      const event = events
        .filter((candidate) => sportsDbSportMatches(sourceItem.sport, candidate.strSport))
        .map((candidate) => ({ event: candidate, score: sourceEventSimilarity(sourceItem, candidate) }))
        .filter(({ score }) => score >= 0.55)
        .sort((left, right) => right.score - left.score)[0]?.event || null;
      if (event) return event;
    } catch (error) {
      if (/HTTP 429/.test(error.message)) {
        sportsDbSearchRateLimited = true;
        console.warn("SportsDB rate limit reached during event search; leaving remaining covers blank rather than using source posters.");
        return null;
      }
      console.warn(`SportsDB event search failed for ${query}: ${error.message}`);
    }
  }
  return null;
}

async function sportsDbEventIndex(items) {
  const requests = [...new Set(items
    .filter((item) => item.releaseInfo)
    .map((item) => String(item.releaseInfo).slice(0, 10)))];
  const index = new Map();
  for (const date of requests) {
    index.set(date, await fetchSportsDbEvents(date));
    if (sportsDbDayRateLimited) break;
  }
  return index;
}

function sportsDbSportMatches(sourceSport, eventSport) {
  const source = String(sourceSport || "").toLowerCase();
  const actual = String(eventSport || "").toLowerCase();
  if (source === "fighting") return /fighting|mma/.test(actual);
  return actual === source;
}

function bestSportsDbEvent(sourceItem, index) {
  const key = String(sourceItem.releaseInfo || "").slice(0, 10);
  const events = (index.get(key) || []).filter((event) => sportsDbSportMatches(sourceItem.sport, event.strSport));
  return events
    .map((event) => ({ event, score: sourceEventSimilarity(sourceItem, event) }))
    .filter(({ score }) => score >= 0.55)
    .sort((left, right) => right.score - left.score)[0]?.event;
}

function cleanMetadataTitle(title) {
  return String(title || "")
    .replace(/\s*-\s*Full Match Replay\s*/i, " — ")
    .replace(/\s+Download.*$/i, "")
    .replace(/\s+-\s+/g, " — ")
    .replace(/\s*—\s*—\s*/g, " — ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sportsDbThumb(event, sourceItem) {
  // SportsDB's Thumb field is the source of truth; never use the Poster field.
  if (event?.strThumb) return event.strThumb;
  const title = String(sourceItem.name || "");
  const verifiedThumbs = [
    [/wales.*japan/i, "https://r2.thesportsdb.com/images/media/event/thumb/gyh34p1793264814.jpg"],
    [/scotland.*new\s+zealand/i, "https://r2.thesportsdb.com/images/media/event/thumb/i5xdqf1793264595.jpg"],
    [/italy.*south\s+africa/i, "https://r2.thesportsdb.com/images/media/event/thumb/a8fwtn1793264390.jpg"],
    [/ireland.*argentina/i, "https://r2.thesportsdb.com/images/media/event/thumb/1227pc1793263472.jpg"],
  ];
  return verifiedThumbs.find(([pattern]) => pattern.test(title))?.[1] || "";
}

function isSportsDbThumbnailTrialItem(sourceItem) {
  return !SPORTSDB_THUMBNAIL_FILTER || String(sourceItem.name || "").toLowerCase().includes(SPORTSDB_THUMBNAIL_FILTER);
}

function sportsDbTitle(event, sourceItem) {
  if (!event) return cleanMetadataTitle(sourceItem.name);
  const title = event.strEvent || [event.strHomeTeam, event.strAwayTeam].filter(Boolean).join(" vs ");
  return [title, event.strLeague].filter(Boolean).join(" — ") || cleanMetadataTitle(sourceItem.name);
}

function sportsDbTags(event, sourceItem) {
  return [...new Set([sourceItem.sport, event?.strLeague || sourceItem.sourceCatalogName].filter(Boolean))];
}

function rugbyCategory(event, sourceItem) {
  const value = `${event?.strLeague || ""} ${sourceItem.name || ""}`;
  if (/top\s*14/i.test(value)) return "Top 14";
  if (/prem|gallagher/i.test(value)) return "Premiership Rugby";
  if (/urc|united rugby/i.test(value)) return "URC";
  if (/champions cup/i.test(value)) return "Champions Cup";
  if (/challenge cup/i.test(value)) return "Challenge Cup";
  if (/six nations/i.test(value)) return "Six Nations";
  if (/super rugby/i.test(value)) return "Super Rugby";
  if (/nrl|super league|league world cup/i.test(value)) return "Rugby League";
  if (/wxv|women/i.test(value)) return "Women's Rugby";
  if (/nations championship/i.test(value)) return "Nations Championship";
  if (/international|test match|b[o\u00f8]ledisloe|rugby championship|world cup/i.test(value)) return "Internationals";
  return "Rugby Union";
}

function outputCatalogId(id) {
  return ["rugby", "mma"].includes(id) ? id : `sports-replay-${id}`;
}

async function buildSportsMetadataOverlay() {
  await loadSportsDbThumbnailCache();
  const sourceItems = (await sportsReplayMovieItems())
    .filter((item) => !SPORTSDB_COMPETITION_FILTER || String(item.name || "").toLowerCase().includes(SPORTSDB_COMPETITION_FILTER))
    .sort((left, right) => String(right.releaseInfo || "").localeCompare(String(left.releaseInfo || "")));
  const thumbnailTrialItems = sourceItems.filter((item) => isSportsDbThumbnailTrialItem(item) && shouldLookupSportsDbThumbnail(item));
  const eventIndex = await sportsDbEventIndex(thumbnailTrialItems);
  const entries = [];
  let matchedCount = 0;

  for (const sourceItem of sourceItems) {
    const isThumbnailTrial = isSportsDbThumbnailTrialItem(sourceItem);
    const cachedPoster = sportsDbThumbnailCache[sourceItem.id]?.poster || "";
    const shouldLookup = isThumbnailTrial && shouldLookupSportsDbThumbnail(sourceItem);
    const event = shouldLookup
      ? bestSportsDbEvent(sourceItem, eventIndex) || await fetchSportsDbSearchEvent(sourceItem)
      : null;
    if (event) matchedCount += 1;
    const date = sourceItem.releaseInfo || event?.dateEventLocal || event?.dateEvent || "";
    const title = sportsDbTitle(event, sourceItem);
    const tags = sportsDbTags(event, sourceItem);
    const poster = cachedPoster || sportsDbThumb(event, sourceItem);
    if (isThumbnailTrial && shouldLookup) {
      sportsDbThumbnailCache[sourceItem.id] = {
        poster,
        checkedAt: new Date().toISOString(),
        lookupVersion: SPORTSDB_THUMBNAIL_CACHE_VERSION,
      };
    }
    const meta = {
      id: sourceItem.id,
      type: "movie",
      name: title,
      posterShape: "landscape",
      poster: poster || undefined,
      background: poster || undefined,
      description: `${title}. Sports replay published ${date}.`,
      releaseInfo: date,
      runtime: sourceItem.runtime || "2h",
      genre: tags,
      genres: tags,
      behaviorHints: { defaultVideoId: sourceItem.id },
    };
    entries.push({ sourceItem, event, meta, category: sourceItem.sport === "Rugby" ? rugbyCategory(event, sourceItem) : sourceItem.sport });
    await writeScopedJson(METADATA_SCOPE, `meta/movie/${sourceItem.id}.json`, { meta });
    await writeScopedJson(SPORTSDB_SCOPE, `meta/movie/${sourceItem.id}.json`, { meta });
  }
  await saveSportsDbThumbnailCache();

  const catalogDefinitions = [
    ["rugby", "Rugby", (entry) => entry.sourceItem.sport === "Rugby"],
    ["mma", "UFC/MMA", (entry) => entry.sourceItem.sport === "Fighting"],
    ["top14", "Top 14", (entry) => entry.category === "Top 14"],
    ["super-rugby", "Super Rugby", (entry) => entry.category === "Super Rugby"],
    ["six-nations", "Six Nations", (entry) => entry.category === "Six Nations"],
    ["nations-championship", "Nations Championship", (entry) => entry.category === "Nations Championship"],
    ["internationals", "Internationals", (entry) => entry.category === "Internationals"],
    ["premiership", "Premiership Rugby", (entry) => entry.category === "Premiership Rugby"],
    ["urc", "URC", (entry) => entry.category === "URC"],
    ["champions-cup", "Champions Cup", (entry) => entry.category === "Champions Cup"],
    ["challenge-cup", "Challenge Cup", (entry) => entry.category === "Challenge Cup"],
    ["rugby-league", "Rugby League", (entry) => entry.category === "Rugby League"],
    ["womens-rugby", "Women's Rugby", (entry) => entry.category === "Women's Rugby"],
    ["rugby-union", "Rugby Union", (entry) => entry.category === "Rugby Union"],
  ];
  const availableCatalogs = [];
  for (const [id, name, test] of catalogDefinitions) {
    const metas = entries
      .filter(test)
      .sort((a, b) => String(b.meta.releaseInfo || "").localeCompare(String(a.meta.releaseInfo || "")))
      .map((entry) => entry.meta);
    if (metas.length) {
      availableCatalogs.push([id, name]);
      const outputId = outputCatalogId(id);
      await writeScopedJson(METADATA_SCOPE, `catalog/movie/${outputId}.json`, { metas });
      await writeScopedJson(CATALOG_SCOPE, `catalog/movie/${outputId}.json`, { metas });
    }
  }

  await writeScopedJson(METADATA_SCOPE, "manifest.json", {
    id: "private.rugby24.sports-replay.metadata",
    version: VERSION,
    name: "Rugby + UFC SportsDB Metadata",
    description: "TheSportsDB titles, event artwork, dates, and competition tags for Rugby and UFC/MMA Sports Replay items.",
    resources: [
      { name: "catalog", types: ["movie"] },
      { name: "meta", types: ["movie"], idPrefixes: ["sports-replay:"] },
    ],
    types: ["movie"],
    catalogs: availableCatalogs.map(([id, name]) => ({ type: "movie", id: outputCatalogId(id), name })),
    behaviorHints: { configurable: false, adult: false, p2p: false },
  });
  await writeScopedJson(CATALOG_SCOPE, "manifest.json", {
    id: "private.rugby24.sports-replay.catalogs",
    version: VERSION,
    name: "Rugby + UFC SportsDB Catalog",
    description: "SportsDB-backed Rugby and UFC/MMA rows; streams remain provided by the Sports Replay add-on.",
    resources: [{ name: "catalog", types: ["movie"] }],
    types: ["movie"],
    catalogs: availableCatalogs.map(([id, name]) => ({ type: "movie", id: outputCatalogId(id), name })),
    behaviorHints: { configurable: false, adult: false, p2p: false },
  });

  const sportsDbCatalogs = [];
  for (const [id, name, test] of catalogDefinitions.filter(([id]) => id !== "mma")) {
    const metas = entries
      .filter(test)
      .sort((a, b) => String(b.meta.releaseInfo || "").localeCompare(String(a.meta.releaseInfo || "")))
      .map((entry) => entry.meta);
    if (!metas.length) continue;
    const outputId = `sportsdb-${id}`;
    sportsDbCatalogs.push([outputId, name]);
    await writeScopedJson(SPORTSDB_SCOPE, `catalog/movie/${outputId}.json`, { metas });
  }
  await writeScopedJson(SPORTSDB_SCOPE, "manifest.json", {
    id: "private.sportsdb.rugby",
    version: VERSION,
    name: "SportsDB",
    description: "SportsDB-backed Rugby catalogue with competition rows, posters, dates, and tags. Streams are provided by Sports Replay.",
    resources: [
      { name: "catalog", types: ["movie"] },
      { name: "meta", types: ["movie"], idPrefixes: ["sports-replay:"] },
    ],
    types: ["movie"],
    catalogs: sportsDbCatalogs.map(([id, name]) => ({ type: "movie", id, name })),
    behaviorHints: { configurable: false, adult: false, p2p: false },
  });
  console.log(`Built SportsDB metadata for ${sourceItems.length} Sports Replay items; matched ${matchedCount} events and wrote ${availableCatalogs.length} catalog rows`);
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

const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
const items = [...all.values()]
  .filter((item) => item.publishedAt >= cutoff)
  .sort((a, b) => b.publishedAt - a.publishedAt || a.title.localeCompare(b.title));
if (!items.length) {
  if (!ALLOW_PUBLISHED_FALLBACK) {
    throw new Error(`No live Rugby24 replay entries were available in the first ${PAGE_COUNT} source page(s). The local trial will not use the published fallback.`);
  }
  console.warn("No Rugby24 pages were available; restoring the last published catalogue without Firecrawl.");
  const fallbackItems = await restorePublishedStaticFiles();
  if (!fallbackItems.length) {
  throw new Error(`No Rugby24 replay entries were available in the last ${MAX_AGE_DAYS} days from the source or the published fallback.`);
  }
  await buildSportsMetadataOverlay();
  console.log(`Restored ${fallbackItems.length} published Rugby24 entries and rebuilt the metadata overlay`);
  process.exit(0);
}
const publishedItems = items.slice(0, MAX_ITEMS);
console.log(`Publishing ${publishedItems.length} newest replays from ${items.length} entries in the last ${MAX_AGE_DAYS} days`);
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
await buildSportsMetadataOverlay();
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
