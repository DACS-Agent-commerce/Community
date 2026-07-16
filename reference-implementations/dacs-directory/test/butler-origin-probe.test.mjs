import assert from "node:assert/strict";
import test from "node:test";
import { assertJsonPostPreflight, checkButlerOrigin } from "../scripts/check-butler-origin.mjs";

const directoryOrigin = "https://directory.example";

function preflight(headers = {}, status = 204) {
  return new Response(null, { status, headers });
}

test("requires POST and content-type in the browser preflight response", () => {
  assert.doesNotThrow(() => assertJsonPostPreflight(preflight({
    "access-control-allow-origin": directoryOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  }), directoryOrigin));

  assert.throws(() => assertJsonPostPreflight(preflight({
    "access-control-allow-origin": directoryOrigin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  }), directoryOrigin), /does not allow POST/);

  assert.throws(() => assertJsonPostPreflight(preflight({
    "access-control-allow-origin": directoryOrigin,
    "access-control-allow-methods": "POST",
  }), directoryOrigin), /does not allow content-type/);

  assert.throws(() => assertJsonPostPreflight(preflight({
    "access-control-allow-origin": "https://wrong.example",
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type",
  }), directoryOrigin), /does not CORS-allow/);
});

test("the live probe performs both the catalog GET and JSON POST preflight", async () => {
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? "GET", headers: init.headers });
    if (init.method === "OPTIONS") return preflight({
      "access-control-allow-origin": directoryOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return new Response(JSON.stringify({ agents: [{ name: "procurement-butler" }] }), {
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": directoryOrigin },
    });
  };

  const result = await checkButlerOrigin({
    env: { NEXT_PUBLIC_DIRECTORY_URL: directoryOrigin, NEXT_PUBLIC_BUTLER_ORIGIN: "https://agents.example" },
    fetcher,
    probe: true,
  });
  assert.match(result, /JSON POST CORS/);
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "OPTIONS", "OPTIONS"]);
  assert.deepEqual(requests.slice(1).map(({ url }) => url), [
    "https://agents.example/demo/procurement",
    "https://agents.example/demo/butler",
  ]);
  assert.deepEqual(requests[1]?.headers, {
    origin: directoryOrigin,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  });
  assert.deepEqual(requests[2]?.headers, requests[1]?.headers);
});
