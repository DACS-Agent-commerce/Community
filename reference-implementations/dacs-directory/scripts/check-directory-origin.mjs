import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function httpsOrigin(env, name) {
  const raw = env[name]?.trim();
  if (!raw) throw new Error(`${name} is required for a production deployment`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }

  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

export function checkDirectoryOrigin({ env = process.env } = {}) {
  const directoryOrigin = httpsOrigin(env, "NEXT_PUBLIC_DIRECTORY_URL");
  return `Production directory origin valid: ${directoryOrigin}`;
}

async function main() {
  try {
    console.log(checkDirectoryOrigin());
  } catch (error) {
    console.error(`[deployment config] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
