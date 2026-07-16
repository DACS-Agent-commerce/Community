const probe = process.argv.includes("--probe");

function httpsOrigin(name) {
  const raw = process.env[name]?.trim();
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

try {
  const directoryOrigin = httpsOrigin("NEXT_PUBLIC_DIRECTORY_URL");
  const butlerOrigin = httpsOrigin("NEXT_PUBLIC_BUTLER_ORIGIN");

  if (probe) {
    const response = await fetch(`${butlerOrigin}/demo/butler/agents`, {
      headers: { origin: directoryOrigin },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Butler catalog probe returned HTTP ${response.status}`);
    if (response.headers.get("access-control-allow-origin") !== directoryOrigin) {
      throw new Error(`Butler gateway does not CORS-allow ${directoryOrigin}`);
    }
    const body = await response.json();
    if (!Array.isArray(body?.agents) || body.agents.length === 0) {
      throw new Error("Butler catalog probe returned no agents");
    }
    console.log(`Butler gateway ready: ${body.agents.length} agents available to ${directoryOrigin}`);
  } else {
    console.log(`Production origins valid: directory=${directoryOrigin} butler=${butlerOrigin}`);
  }
} catch (error) {
  console.error(`[deployment config] ${error.message}`);
  process.exitCode = 1;
}
