import test from "node:test";
import assert from "node:assert/strict";
import { parseArticle, parseListing, parsePublishedDate } from "../src/parser.js";

test("parses dates in the site's published-title format", () => {
  assert.equal(parsePublishedDate("Pau v Toulouse - 1 November 2026")?.toISOString(), "2026-11-01T00:00:00.000Z");
});

test("extracts and sorts replay cards by publication date", () => {
  const html = `
    <article><a href="/older-full-match-replay-30-october-2026"><img src="/_pu/1.jpg"></a>
      <h3><a href="/older-full-match-replay-30-october-2026">Older v Side - Full Match Replay - 30 October 2026</a></h3></article>
    <article><a href="/newer-full-match-replay-1-november-2026"><img src="/_pu/2.jpg"></a>
      <h3><a href="/newer-full-match-replay-1-november-2026">Newer v Side - Full Match Replay - 1 November 2026</a></h3></article>`;
  const entries = parseListing(html, "https://rugby24.net/");
  assert.deepEqual(entries.map((entry) => entry.title), [
    "Newer v Side - Full Match Replay - 1 November 2026",
    "Older v Side - Full Match Replay - 30 October 2026",
  ]);
  assert.equal(entries[0].poster, "https://rugby24.net/_pu/2.jpg");
});

test("extracts article poster, duration and explicit HLS URL without parsing the captcha provider", () => {
  const html = `
    <h1>Newer v Side - Full Match Replay - 1 November 2026</h1>
    <img alt="Newer v Side Rugby Video" src="/_pu/2.jpg">
    <div data-options='{&quot;duration&quot;:&quot;3600&quot;,&quot;hlsManifestUrl&quot;:&quot;https://media.example/video.m3u8?x=1&amp;y=2&quot;}'></div>
    <iframe src="https://bysesukior.com/e/blocked"></iframe>`;
  const article = parseArticle(html, "https://rugby24.net/newer-full-match-replay-1-november-2026");
  assert.equal(article.durationSeconds, 3600);
  assert.equal(article.hlsUrl, "https://media.example/video.m3u8?x=1&y=2");
  assert.deepEqual(article.embeds, ["https://bysesukior.com/e/blocked"]);
});

test("decodes escaped HLS query separators from OK player metadata", () => {
  const html = '<div data-options="{&quot;hlsManifestUrl&quot;:&quot;https://media.example/video.m3u8?cmd=play\\u0026expires=123&quot;}"></div>';
  const article = parseArticle(html, "https://rugby24.net/example-full-match-replay-1-november-2026");
  assert.equal(article.hlsUrl, "https://media.example/video.m3u8?cmd=play&expires=123");
});
