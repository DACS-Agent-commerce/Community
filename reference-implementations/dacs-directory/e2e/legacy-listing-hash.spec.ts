import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let browserScript: string;
test.beforeAll(async () => {
  // Bundle the real reader and its production crypto shim, rather than copying
  // canonicalization into the test or sorting fixtures in the Node runner.
  const result = await build({
    stdin: {
      contents: `
        import { Buffer } from "buffer";
        import { legacyListingHash } from "./src/catalog/legacyListingHash.js";
        import { canonicalize } from "./src/catalog/canonical.js";
        import { registerLegacyListingHashCases } from "./test/fixtures/legacy-listing-hash-cases.js";
        globalThis.Buffer = Buffer;
        export function run() {
          const names = [];
          const assert = {
            equal(actual, expected) { if (!Object.is(actual, expected)) throw new Error(actual + " != " + expected); },
            match(actual, expected) { if (!expected.test(actual)) throw new Error("pattern mismatch: " + actual); },
            throws(run, expected) {
              try { run(); } catch (error) {
                if (expected.test(String(error))) return;
                throw error;
              }
              throw new Error("expected rejection: " + expected);
            },
          };
          registerLegacyListingHashCases((name, run) => { run(); names.push(name); }, assert,
            legacyListingHash, canonicalize, preimage => globalThis.expectedDigests[preimage]);
          return names;
        }
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "HistoricalHashRegression",
    plugins: [{
      name: "production-browser-shims",
      setup(builder) {
        builder.onResolve({ filter: /^node:(crypto|util|net|url)$/ }, ({ path }) => ({
          path: fileURLToPath(new URL(`../src/shims/${path.replace(":", "-")}.ts`, import.meta.url)),
        }));
      },
    }],
  });
  browserScript = result.outputFiles[0].text;
});

test("historical exact preimages and NFC insertion ordering hold in the browser", async ({ page }) => {
  // Produce independent SHA-256 expectations with Node; all serialization and
  // sorting assertions execute in the browser, including undefined and null.
  const { createHash } = await import("node:crypto");
  const { registerLegacyListingHashCases } = await import("../test/fixtures/legacy-listing-hash-cases.js");
  const expectedDigests: Record<string, string> = {};
  const ignore = { equal() {}, match() {}, throws() {} };
  // Collect the literal preimages while exercising the same case bodies. This
  // does not use the implementation under test to compute expected digests.
  registerLegacyListingHashCases((_name, run) => run(), ignore, () => "", () => "", preimage => {
    expectedDigests[preimage] = createHash("sha256").update(preimage, "utf8").digest("hex");
    return expectedDigests[preimage];
  });
  await page.addScriptTag({ content: `globalThis.expectedDigests = ${JSON.stringify(expectedDigests)};` });
  await page.addScriptTag({ content: browserScript });
  const names = await page.evaluate(() => (globalThis as unknown as {
    HistoricalHashRegression: { run(): string[] };
  }).HistoricalHashRegression.run());
  expect(names).toHaveLength(5);
  expect(names).toContain("historical equal-name stability spans a galloping merge between long sorted runs");
});
