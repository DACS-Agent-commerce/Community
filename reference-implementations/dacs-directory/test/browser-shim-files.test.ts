import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import nextConfig from "../next.config.mjs";
import { BROWSER_BUFFER_PROVISION, BROWSER_SHIM_FILES } from "../src/shims/browser-shim-files.mjs";

type Resource = { request: string };
type Replacement = { pattern: RegExp; replace: (resource: Resource) => void };
type WebpackHook = (config: { resolve: object; plugins: unknown[] }, context: { isServer: boolean; webpack: object }) => unknown;

/** Run next.config.mjs's webpack hook for the client build with plugin recorders. */
function clientBuildPlugins() {
  const replacements: Replacement[] = [];
  const provided: Array<Record<string, string[]>> = [];
  class NormalModuleReplacementPlugin {
    constructor(pattern: RegExp, replace: (resource: Resource) => void) { replacements.push({ pattern, replace }); }
  }
  class ProvidePlugin {
    constructor(definitions: Record<string, string[]>) { provided.push(definitions); }
  }
  const config = { resolve: {}, plugins: [] as unknown[] };
  (nextConfig.webpack as unknown as WebpackHook)(config,{ isServer: false, webpack: { NormalModuleReplacementPlugin, ProvidePlugin } });
  return { replacements, provided };
}

test("the production browser bundle replaces exactly the shared Node built-ins with their shim files", () => {
  const { replacements } = clientBuildPlugins();
  assert.equal(replacements.length, Object.keys(BROWSER_SHIM_FILES).length, "no replacement outside the shared table");
  for (const [specifier, shimFile] of Object.entries(BROWSER_SHIM_FILES)) {
    const shimPath = fileURLToPath(new URL(`../src/shims/${shimFile}`, import.meta.url));
    assert.ok(existsSync(shimPath), `${shimFile} exists`);
    const matching = replacements.filter(({ pattern }) => pattern.test(specifier));
    assert.equal(matching.length, 1, `${specifier} is replaced once`);
    const resource = { request: specifier };
    matching[0].replace(resource);
    assert.equal(resource.request, shimPath, specifier);
  }
});

test("the production browser bundle provides the shared Buffer global", () => {
  const { provided } = clientBuildPlugins();
  assert.deepEqual(provided, [{ [BROWSER_BUFFER_PROVISION[1]]: [...BROWSER_BUFFER_PROVISION] }]);
});
