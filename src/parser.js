const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const ARTICLE_HINT = /(full\s+match|match\s+replay|highlights?|replay)/i;

export function decodeHtml(value = "") {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'");
}

export function stripTags(value = "") {
  return decodeHtml(value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function absoluteUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return url.origin === new URL(baseUrl).origin ? url.href : "";
  } catch {
    return "";
  }
}

export function parsePublishedDate(text = "") {
  const match = text.replace(/\u00a0/g, " ").match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function candidateEntries(html, baseUrl) {
  const entries = new Map();
  const anchorRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const anchor = match[0];
    const href = absoluteUrl(attribute(anchor.match(/^<a\b[^>]*>/i)?.[0] ?? "", "href"), baseUrl);
    if (!href || href === `${new URL(baseUrl).origin}/` || href.includes("#")) continue;
    const text = stripTags(anchor);
    if (!ARTICLE_HINT.test(text)) continue;
    const date = parsePublishedDate(text);
    if (!date) continue;
    const image = attribute(anchor.match(/<img\b[^>]*>/i)?.[0] ?? "", "src");
    const existing = entries.get(href);
    if (!existing || text.length > existing.title.length) {
      entries.set(href, {
        url: href,
        title: text,
        publishedAt: date,
        poster: image ? new URL(image, baseUrl).href : "",
      });
    }
  }
  return [...entries.values()];
}

export function parseListing(html, baseUrl) {
  const entries = candidateEntries(html, baseUrl);
  const posterByUrl = new Map();
  const imageAnchorRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  for (const match of html.matchAll(imageAnchorRe)) {
    const anchor = match[0];
    const href = absoluteUrl(attribute(anchor.match(/^<a\b[^>]*>/i)?.[0] ?? "", "href"), baseUrl);
    const image = attribute(anchor.match(/<img\b[^>]*>/i)?.[0] ?? "", "src");
    if (href && image) posterByUrl.set(href, new URL(image, baseUrl).href);
  }

  // Some pages keep the full title in a heading anchor while the poster is in
  // a separate anchor. Merge those two representations by URL.
  const headingRe = /<h[2-5]\b[^>]*>[\s\S]*?<a\b[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h[2-5]>/gi;
  for (const match of html.matchAll(headingRe)) {
    const block = match[0];
    const anchor = block.match(/<a\b[^>]*>[\s\S]*?<\/a>/i)?.[0] ?? "";
    const href = absoluteUrl(attribute(anchor.match(/^<a\b[^>]*>/i)?.[0] ?? "", "href"), baseUrl);
    const title = stripTags(anchor);
    if (!href || !ARTICLE_HINT.test(title)) continue;
    const date = parsePublishedDate(title);
    if (!date) continue;
    const current = entries.find((entry) => entry.url === href);
    if (current) {
      current.title = title;
      current.publishedAt = date;
      current.poster ||= posterByUrl.get(href) || "";
    } else {
      entries.push({ url: href, title, publishedAt: date, poster: posterByUrl.get(href) || "" });
    }
  }

  return entries.sort((a, b) => b.publishedAt - a.publishedAt || a.title.localeCompare(b.title));
}

export function parseListingMarkdown(markdown, baseUrl) {
  const entries = new Map();
  const posterByUrl = new Map();
  const imageRe = /\[!\[[^\]]*\]\(([^)]+)\)\]\((https?:\/\/[^)\s]+)\)/gi;
  for (const match of markdown.matchAll(imageRe)) {
    try {
      posterByUrl.set(match[2], new URL(match[1], baseUrl).href);
    } catch {
      // Ignore malformed image URLs from the proxy response.
    }
  }

  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
  for (const match of markdown.matchAll(linkRe)) {
    const title = decodeHtml(match[1]).replace(/[*_`]/g, "").trim();
    const url = absoluteUrl(match[2], baseUrl);
    if (!url || !ARTICLE_HINT.test(title)) continue;
    const date = parsePublishedDate(title);
    if (!date) continue;
    const existing = entries.get(url);
    if (!existing || title.length > existing.title.length) {
      entries.set(url, {
        url,
        title,
        publishedAt: date,
        poster: posterByUrl.get(url) || existing?.poster || "",
      });
    }
  }

  return [...entries.values()].sort((a, b) => b.publishedAt - a.publishedAt || a.title.localeCompare(b.title));
}

export function parseArticle(html, articleUrl) {
  const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)?.[0] ?? "";
  const title = stripTags(heading) || stripTags(html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i)?.[0] ?? "")
    .replace(/\s*\|\s*Rugby24.*$/i, "")
    .trim();
  const posterMatch = html.match(/<img\b[^>]*alt=["'][^"']*(?:Rugby|Match|Replay)[^"']*["'][^>]*>/i) ?? html.match(/<img\b[^>]*>/i);
  const poster = posterMatch ? attribute(posterMatch[0], "src") : "";
  const publishedAt = parsePublishedDate(title);
  const category = stripTags(html.match(/<div[^>]+class=["'][^"']*(?:breadcrumb|breadcrumbs)[^"']*["'][^>]*>[\s\S]*?<\/div>/i)?.[0] ?? "")
    .split(/\s*[»>]\s*/).filter(Boolean).pop() ?? "Rugby";

  const durationMatch = decodeHtml(html).match(/"duration"\s*:\s*"?(\d+)"?/i);
  const description = stripTags(html.match(/<meta\b[^>]+name=["']description["'][^>]*>/i)?.[0] ?? "") ||
    `Authorized Rugby24 replay: ${title}`;

  const embeds = [];
  const srcRe = /(?:src|data-src)=["'](https?:\/\/[^"']+)["']/gi;
  for (const match of html.matchAll(srcRe)) {
    const url = decodeHtml(match[1]);
    if (/^(https?:\/\/)(?:www\.)?(ok\.ru|bysesukior\.com)\//i.test(url) && !embeds.includes(url)) embeds.push(url);
  }

  const decodedHtml = decodeHtml(html);
  const hlsMatch = decodedHtml.match(/"hlsManifestUrl"\s*:\s*"(https?:\/\/[^"\\]+\.m3u8[^"\\]*)"/i) ??
    decodedHtml.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);

  return {
    title,
    articleUrl,
    poster: poster ? new URL(poster, articleUrl).href : "",
    publishedAt,
    category,
    description,
    durationSeconds: durationMatch ? Number(durationMatch[1]) : undefined,
    embeds,
    hlsUrl: hlsMatch ? hlsMatch[1].replace(/\\u0026/g, "&amp;").replace(/&amp;/g, "&") : "",
  };
}

export function parsePagination(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const label = stripTags(match[2]);
    const url = absoluteUrl(match[1], baseUrl);
    if (url && /^\d+$/.test(label)) links.push({ label: Number(label), url });
  }
  return links.sort((a, b) => a.label - b.label);
}
