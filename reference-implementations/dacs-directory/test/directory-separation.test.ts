import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The gateway demo (Try DACS, Try Chat, the Butler origin, and its paid/live
// browser suite) moved out of the Directory. These checks keep it out.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(appDir, path), "utf8");
// ("live-paid" alone is a DACS evidence tier the catalog still reports.)
const GATEWAY = /butler|try-?dacs|try-?chat|e2e:live|live_paid|HomeDealDemo|\/try\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(appDir, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|mjs|css|sh)$/.test(entry.name) ? [path] : [];
  });
}

test("the Directory has no gateway routes, components, or scripts", () => {
  for (const route of ["app/try", "app/try-chat"]) assert.ok(!existsSync(join(appDir, route)), route);
  for (const file of ["app", "src", "e2e", "scripts"].flatMap(sourceFiles)) {
    assert.doesNotMatch(read(file), GATEWAY, file);
  }
});

test("package scripts, Railway, and CI carry no gateway configuration", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(`${name} ${command}`, GATEWAY, name);
  }
  assert.equal(scripts["test:e2e"], "playwright test e2e/home.spec.ts e2e/register.spec.ts && playwright test --config=playwright.hash.config.ts --project=chromium");
  assert.doesNotMatch(read("railway.json"), GATEWAY);
  assert.doesNotMatch(read("playwright.config.ts"), GATEWAY);
  assert.doesNotMatch(read("../../.github/workflows/dacs-directory-ci.yml"), GATEWAY);
});

test("the sitemap advertises only the Directory's own pages", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "directory-separation-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  process.env.DACS_DIRECTORY_DATA = data;
  process.env.NEXT_PUBLIC_DIRECTORY_URL = "https://directory.dacs.dev";
  const { default: sitemap } = await import("../app/sitemap.js");
  assert.deepEqual(
    sitemap().map((entry) => entry.url),
    ["", "/discover", "/how-it-works", "/verify", "/register"].map((path) => `https://directory.dacs.dev${path}`),
  );
});
