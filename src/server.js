import http from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { decodeHtml, parseArticle, parseListing } from "./parser.js";

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || "0.0.0.0";
const SOURCE = new URL(process.env.RUGBY24_BASE_URL || "https://rugby24.net/");
const ADDON_TOKEN = (process.env.ADDON_TOKEN || "").trim();
const STREAM_MODE = (process.env.STREAM_MODE || "external").toLowerCase();
const FETCH_MODE = (process.env.FETCH_MODE || "curl").toLowerCase();
const PAGE_SIZE = Math.min(Math.max(Number(process.env.PAGE_SIZE || 20), 1), 50);
const CACHE_TTL_MS = Math.max(Number(process.env.CACHE_TTL_SECONDS || 300), 30) * 1000;
const USER_AGENT = process.env.USER_AGENT || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";

const CATEGORY_PATHS = {
  "rugby24-latest": { name: "Latest rugby replays", path: "" },
  "rugby24-premiership": { name: "Premiership Rugby", path: "premiership-rugby" },
  "rugby24-top14": { name: "Top 14 Rugby", path: "top14" },
  "rugby24-urc": { name: "United Rugby Championship", path: "urc" },
  "rugby24-champions-cup": { name: "Champions Cup", path: "champions-cup" },
  "rugby24-six-nations": { name: "Six Nations", path: "six-nations" },
  "rugby24-super-rugby": { name: "Super Rugby", path: "super_rugby_games" },
  "rugby24-internationals": { name: "Rugby Internationals", path: "rugby-internationals" },
  "rugby24-league": { name: "Rugby League", path: "nrl" },
};

const cache = new Map();

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

async function fetchHtml(url) {
  const cacheKey = url.href;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.html;
  const html = FETCH_MODE === "curl" ? await fetchWithCurl(url) : await fetchWithFetch(url);
  cache.set(cacheKey, { html, expiresAt: Date.now() + CACHE_TTL_MS });
  return html;
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

async function fetchWithFetch(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-AU,en;q=0.9",
      Referer: SOURCE.href,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return response.text();
}

function basePath() {
  return ADDON_TOKEN ? `/${encodeURIComponent(ADDON_TOKEN)}` : "";
}

function routePath(url) {
  let path = url.pathname;
  if (ADDON_TOKEN) {
    const prefix = `${basePath()}/`;
    if (path === basePath()) path = "/";
    else if (path.startsWith(prefix)) path = path.slice(prefix.length - 1);
    else return null;
  }
  return path;
}

function manifest(origin) {
  return {
    id: "private.rugby24.nuvio",
    version: "0.1.0",
    name: "Private Rugby24 Archive",
    description: "A private, date-ordered catalog of authorized Rugby24 replay pages.",
    logo: "https://rugby24.net/_pu/71/68220798.jpg",
    resources: [
      { name: "catalog", types: ["movie"] },
      { name: "meta", types: ["movie"], idPrefixes: ["rugby24:"] },
      { name: "stream", types: ["movie"], idPrefixes: ["rugby24:"] },
    ],
    types: ["movie"],
    catalogs: Object.entries(CATEGORY_PATHS).map(([id, config]) => ({
      type: "movie",
      id,
      name: config.name,
      extra: [{ name: "skip", isRequired: false }, { name: "search", isRequired: false }],
    })),
    behaviorHints: { configurable: false, adult: false, p2p: false },
    addonUrl: origin,
  };
}

function pageUrl(path, pageNumber) {
  const url = new URL(path ? `/${path}` : "/", SOURCE);
  if (pageNumber > 0) url.search = `?page${pageNumber + 1}`;
  return url;
}

function parseExtra(raw = "") {
  const result = {};
  for (const pair of raw.split("&")) {
    const [key, value = ""] = pair.split("=");
    if (key) result[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return result;
}

function articleId(url) {
  return `rugby24:${new URL(url).pathname.replace(/^\/+/, "")}`;
}

function itemToPreview(item, categoryName) {
  return {
    id: articleId(item.url),
    type: "movie",
    name: item.title,
    poster: item.poster || undefined,
    description: `${categoryName} — published ${item.publishedAt.toISOString().slice(0, 10)}.`,
    releaseInfo: item.publishedAt.toISOString().slice(0, 10),
    genres: [categoryName],
  };
}

async function catalogResponse(catalogId, extras) {
  const config = CATEGORY_PATHS[catalogId];
  if (!config) throw new Error("Unknown catalog");
  const skip = Math.max(Number(extras.skip || 0), 0);
  const firstPage = parseListing(await fetchHtml(pageUrl(config.path, 0)), SOURCE.href);
  const sourcePageSize = firstPage.length || 12;
  const pageNumber = Math.floor(skip / sourcePageSize);
  const pages = extras.search ? [0, 1, 2] : Array.from({ length: pageNumber + 1 }, (_, index) => index);
  const all = [];
  for (const page of [...new Set(pages)]) {
    const entries = page === 0 ? firstPage : parseListing(await fetchHtml(pageUrl(config.path, page)), SOURCE.href);
    all.push(...entries);
  }
  const deduped = new Map(all.map((item) => [item.url, item]));
  let items = [...deduped.values()].sort((a, b) => b.publishedAt - a.publishedAt || a.title.localeCompare(b.title));
  if (extras.search) {
    const query = extras.search.toLowerCase();
    items = items.filter((item) => item.title.toLowerCase().includes(query));
  }
  const pageItems = items.slice(skip, skip + PAGE_SIZE);
  return { metas: pageItems.map((item) => itemToPreview(item, config.name)) };
}

function idToArticleUrl(id) {
  if (!id.startsWith("rugby24:")) return null;
  const pathname = id.slice("rugby24:".length);
  if (!pathname || pathname.includes("..") || pathname.includes("//")) return null;
  return new URL(`/${pathname}`, SOURCE).href;
}

async function metaResponse(id) {
  const articleUrl = idToArticleUrl(id);
  if (!articleUrl) throw new Error("Unsupported content id");
  const article = parseArticle(await fetchHtml(new URL(articleUrl)), articleUrl);
  return {
    meta: {
      id,
      type: "movie",
      name: article.title,
      poster: article.poster || undefined,
      description: article.description,
      releaseInfo: article.publishedAt?.toISOString().slice(0, 10),
      runtime: article.durationSeconds ? formatDuration(article.durationSeconds) : undefined,
      genres: article.category ? [article.category] : ["Rugby"],
      links: [{ name: "Original source page", category: "movie", url: article.articleUrl }],
    },
  };
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function streamResponse(id) {
  const articleUrl = idToArticleUrl(id);
  if (!articleUrl) throw new Error("Unsupported content id");
  const article = parseArticle(await fetchHtml(new URL(articleUrl)), articleUrl);
  const streams = [];
  if (STREAM_MODE === "direct" && article.hlsUrl) {
    streams.push({
      name: "Direct HLS",
      description: "Signed HLS URL found in the authorized source page; availability depends on the upstream provider.",
      url: article.hlsUrl,
      behaviorHints: { notWebReady: true, bingeGroup: "rugby24-direct" },
    });
  }
  streams.push({
    name: "Open source page",
    description: "Open the original Rugby24 page and use its embedded player.",
    externalUrl: article.articleUrl,
    behaviorHints: { bingeGroup: "rugby24-page" },
  });
  return { streams };
}

async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = routePath(url);
  if (path === null) return text(res, 404, "Not found");
  try {
    if (path === "/" || path === "/manifest.json") return json(res, 200, manifest(`${url.origin}${basePath()}/manifest.json`));

    const catalogMatch = path.match(/^\/catalog\/movie\/([^/]+)(?:\/([^/]+))?\.json$/);
    if (catalogMatch) return json(res, 200, await catalogResponse(catalogMatch[1], parseExtra(catalogMatch[2] || "")));

    const metaMatch = path.match(/^\/meta\/movie\/(.+)\.json$/);
    if (metaMatch) return json(res, 200, await metaResponse(decodeURIComponent(metaMatch[1])));

    const streamMatch = path.match(/^\/stream\/movie\/(.+)\.json$/);
    if (streamMatch) return json(res, 200, await streamResponse(decodeURIComponent(streamMatch[1])));

    return text(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    return json(res, 502, { error: "Upstream source unavailable", message: error.message });
  }
}

http.createServer(handler).listen(PORT, HOST, () => {
  const path = `${basePath()}/manifest.json`;
  console.log(`Private Rugby24 Nuvio add-on listening on http://localhost:${PORT}${path}`);
  console.log(`STREAM_MODE=${STREAM_MODE}; FETCH_MODE=${FETCH_MODE}; source=${SOURCE.origin}`);
});
