import http from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "static", "dist");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.STATIC_PORT || 7100);
const token = (process.env.ADDON_TOKEN || "").trim();

if (!token || token === "replace-with-a-long-random-token") {
  console.error("ADDON_TOKEN is missing. Set it in .env before starting the local static server.");
  process.exit(1);
}

const contentTypes = {
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function safeFilePath(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const candidate = normalize(join(dist, decoded.replace(/^\/+/, "")));
  const rel = relative(dist, candidate);
  if (rel.startsWith("..") || rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) return null;
  return candidate;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const expectedPrefix = `/${encodeURIComponent(token)}/`;
    if (!requestUrl.pathname.startsWith(expectedPrefix)) return send(res, 404, "Not found");

    const file = safeFilePath(requestUrl.pathname.slice(1));
    if (!file) return send(res, 400, "Bad path");
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, "Not found");
    const body = await readFile(file);
    return send(res, 200, req.method === "HEAD" ? "" : body, {
      "Content-Type": contentTypes[extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": String(body.length),
    });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return send(res, 404, "Not found");
    console.error(error);
    return send(res, 500, "Local static server error");
  }
});

await access(join(dist, token, "manifest.json"), constants.F_OK).catch(() => {
  console.error("No generated static manifest found. Run `npm run trial:refresh` first.");
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Local static add-on listening on http://127.0.0.1:${port}/${encodeURIComponent(token)}/manifest.json`);
  console.log(`For Nuvio on another device, replace 127.0.0.1 with this Mac's LAN IP.`);
  console.log("Press Ctrl+C to stop it.");
});
