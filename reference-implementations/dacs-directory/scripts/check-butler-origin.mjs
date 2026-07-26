import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function httpsOrigin(env, name) {
  const raw = env[name]?.trim();
  if (!raw) throw new Error(`${name} is required for a production deployment`);
  let url;
  try { url = new URL(raw); }
  catch { throw new Error(`${name} must be an absolute URL`); }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

function headerValues(response, name) {
  return (response.headers.get(name) ?? "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
}

export function assertCorsOrigin(response, directoryOrigin, requestLabel) {
  if (response.headers.get("access-control-allow-origin") !== directoryOrigin) {
    throw new Error(`Butler gateway does not CORS-allow ${directoryOrigin} for ${requestLabel}`);
  }
}

export function assertJsonPostPreflight(response, directoryOrigin) {
  if (!response.ok) throw new Error(`Butler JSON POST preflight returned HTTP ${response.status}`);
  assertCorsOrigin(response, directoryOrigin, "JSON POST preflight");
  if (!headerValues(response, "access-control-allow-methods").includes("post")) {
    throw new Error("Butler JSON POST preflight does not allow POST");
  }
  if (!headerValues(response, "access-control-allow-headers").includes("content-type")) {
    throw new Error("Butler JSON POST preflight does not allow content-type");
  }
}

export async function checkButlerOrigin({ env = process.env, fetcher = fetch, probe = false } = {}) {
  const directoryOrigin = httpsOrigin(env, "NEXT_PUBLIC_DIRECTORY_URL");
  const butlerOrigin = httpsOrigin(env, "NEXT_PUBLIC_BUTLER_ORIGIN");

  if (!probe) return `Production origins valid: directory=${directoryOrigin} butler=${butlerOrigin}`;

  const response = await fetcher(`${butlerOrigin}/demo/butler/agents`, {
    headers: { origin: directoryOrigin },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Butler catalog probe returned HTTP ${response.status}`);
  assertCorsOrigin(response, directoryOrigin, "catalog GET");
  const body = await response.json();
  if (!Array.isArray(body?.agents) || body.agents.length === 0) {
    throw new Error("Butler catalog probe returned no agents");
  }

  for (const path of ["/demo/procurement", "/demo/butler"]) {
    const preflight = await fetcher(`${butlerOrigin}${path}`, {
      method: "OPTIONS",
      headers: {
        origin: directoryOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
      signal: AbortSignal.timeout(10_000),
    });
    try { assertJsonPostPreflight(preflight, directoryOrigin); }
    catch (cause) { throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  return `Butler gateway ready: ${body.agents.length} agents and JSON POST CORS available to ${directoryOrigin}`;
}

async function main() {
  try {
    console.log(await checkButlerOrigin({ probe: process.argv.includes("--probe") }));
  } catch (error) {
    console.error(`[deployment config] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
