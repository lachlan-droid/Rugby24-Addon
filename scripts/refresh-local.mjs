import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();

async function loadDotEnv() {
  const filename = join(root, ".env");
  try {
    await access(filename, constants.F_OK);
  } catch {
    return;
  }

  const contents = await readFile(filename, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    process.env[match[1]] = value;
  }
}

await loadDotEnv();

if (!process.env.ADDON_TOKEN || process.env.ADDON_TOKEN === "replace-with-a-long-random-token") {
  console.error("ADDON_TOKEN is missing. Copy .env.example to .env and set a private token first.");
  process.exit(1);
}

const env = {
  ...process.env,
  // First-page proof of concept: no paid crawl service, no stale fallback.
  USE_FIRECRAWL: "false",
  SKIP_LIVE_SOURCE: "false",
  ALLOW_PUBLISHED_FALLBACK: "false",
  MAX_SOURCE_PAGES: "1",
  MAX_ITEMS: process.env.MAX_ITEMS || "20",
  MAX_AGE_DAYS: process.env.MAX_AGE_DAYS || "180",
  EMBED_RESOLVE_LIMIT: process.env.EMBED_RESOLVE_LIMIT || "20",
  STATIC_VERSION: `local-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
};

console.log("Refreshing the first Rugby24 source page locally (Firecrawl disabled)…");
const child = spawn(process.execPath, ["static/build-static.mjs"], {
  cwd: root,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not start the local refresh: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Local refresh stopped by ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
