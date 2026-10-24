/**
 * The Node built-ins the production browser bundle replaces, mapped to the
 * file in this folder that replaces each. next.config.mjs and the browser hash
 * spec both read this table, so the spec bundles exactly what production ships.
 */
export const BROWSER_SHIM_FILES = Object.freeze({
  "node:crypto": "node-crypto.ts",
  "node:util": "node-util.ts",
  "node:net": "node-net.ts",
  "node:url": "node-url.ts",
});

/** The `Buffer` global production injects into every module: [module, export]. */
export const BROWSER_BUFFER_PROVISION = Object.freeze(["buffer", "Buffer"]);
