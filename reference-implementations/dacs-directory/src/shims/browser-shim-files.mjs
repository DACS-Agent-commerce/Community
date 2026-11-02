import { fileURLToPath } from "node:url";

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

/**
 * The `Buffer` global production injects into every module: [module, export].
 * It is the base64url-aware wrapper of the npm `buffer` package, so the SDK code
 * that encodes base64url when its module loads gets the patched class.
 */
export const BROWSER_BUFFER_PROVISION = Object.freeze([fileURLToPath(new URL("./buffer.ts", import.meta.url)), "Buffer"]);
