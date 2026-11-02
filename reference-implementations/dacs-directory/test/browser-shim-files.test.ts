import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import nextConfig from "../next.config.mjs";
import { BROWSER_BUFFER_PROVISION, BROWSER_SHIM_FILES } from "../src/shims/browser-shim-files.mjs";

type Resource = { request: string };
type Replacement = { pattern: RegExp; replace: (resource: Resource) => void };
type WebpackHook = (config: { resolve: object; plugins: unknown[] }, context: { isServer: boolean; webpack: object }) => unknown;

/**
 * Run next.config.mjs's webpack hook for the client build with plugin recorders.
 * `nextProvides` stands in for the ProvidePlugin definitions Next registers itself.
 */
function clientBuildPlugins(nextProvides?: Record<string, string[]>) {
  const replacements: Replacement[] = [];
  const provided: Array<Record<string, string[]>> = [];
  class NormalModuleReplacementPlugin {
    constructor(pattern: RegExp, replace: (resource: Resource) => void) { replacements.push({ pattern, replace }); }
  }
  class ProvidePlugin {
    definitions: Record<string, string[]>;
    constructor(definitions: Record<string, string[]>) { this.definitions = definitions; provided.push(definitions); }
  }
  const config = { resolve: {}, plugins: [] as unknown[] };
  if (nextProvides) config.plugins.push(new ProvidePlugin(nextProvides));
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

test("the production browser bundle redirects Next's own Buffer provision to the shared Buffer", () => {
  // Next provides Buffer from the plain npm `buffer`, and webpack uses the first
  // ProvidePlugin that defines a name, so a second definition would never apply.
  const { provided } = clientBuildPlugins({ Buffer: ["buffer", "Buffer"], process: ["process"] });
  assert.deepEqual(provided, [{ Buffer: [...BROWSER_BUFFER_PROVISION], process: ["process"] }]);
});
