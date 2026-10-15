// This fixture lane only inspects local catalog data. Refuse external I/O.
const http = require("node:http");
const https = require("node:https");
const { syncBuiltinESMExports } = require("node:module");
const local = (hostname) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) throw new Error("External network disabled in catalog fixture tests");
  return originalFetch(input, options);
};
for (const transport of [http, https]) {
  for (const method of ["request", "get"]) {
    const original = transport[method];
    transport[method] = function (input, ...args) {
      const hostname = typeof input === "string" || input instanceof URL
        ? new URL(input).hostname : (input.hostname ?? input.host ?? "localhost");
      if (!local(hostname)) throw new Error("External network disabled in catalog fixture tests");
      return original.call(this, input, ...args);
    };
  }
}
syncBuiltinESMExports();
