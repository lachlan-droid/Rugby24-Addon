import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const env = { ...process.env };

try {
  const contents = await readFile(join(root, ".env"), "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in env) continue;
    const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (!env.ADDON_TOKEN || env.ADDON_TOKEN === "replace-with-a-long-random-token") {
  console.error("ADDON_TOKEN is missing. Copy .env.example to .env and set a private token first.");
  process.exit(1);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

const refresh = await run(process.execPath, [join("scripts", "refresh-local.mjs")]);
if (refresh.signal || refresh.code !== 0) process.exit(refresh.code || 1);

const server = spawn(process.execPath, [join("scripts", "serve-static.mjs")], {
  cwd: root,
  env,
  stdio: "inherit",
});

const stop = () => server.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("close", (code) => process.exit(code ?? 0));
