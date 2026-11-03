import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const APP_DIR = "reference-implementations/dacs-directory";
const MAX_RETENTION_DAYS = 14;

// The step that follows the browser regression step, as a block of text.
function stepAfterBrowserTests() {
  const ci = read("../../../.github/workflows/dacs-directory-ci.yml");
  const steps = ci.split(/^ {6}(?=- )/m);
  const browser = steps.findIndex(step => /^- name: Browser regression tests$/m.test(step));
  assert.ok(browser >= 0, "the browser regression step is missing");
  assert.ok(browser + 1 < steps.length, "nothing follows the browser regression step");
  return steps[browser + 1];
}

test("uploads on failure right after the browser step", () => {
  const upload = stepAfterBrowserTests();
  assert.match(upload, /^ +uses: actions\/upload-artifact@/m);
  assert.match(upload, /^ +if: failure\(\)$/m);
});

test("pins the upload action to a full commit SHA", () => {
  assert.match(stepAfterBrowserTests(), /^ +uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m);
});

// `path` is resolved from the repository root, not from the run step's
// working-directory, so the app folder has to be spelled out.
test("uploads the report and results folders Playwright writes", () => {
  const upload = stepAfterBrowserTests();
  const config = read("../playwright.config.ts");
  const reportFolder = config.match(/outputFolder: "([^"]+)"/)?.[1];
  const resultsFolder = config.match(/outputDir: "([^/"]+)\//)?.[1];
  assert.equal(reportFolder, "playwright-report");
  assert.equal(resultsFolder, "test-results");
  assert.match(upload, new RegExp(`^ +${APP_DIR}/${reportFolder}/$`, "m"));
  assert.match(upload, new RegExp(`^ +${APP_DIR}/${resultsFolder}/$`, "m"));
});

test("keeps artifacts briefly and ignores missing files", () => {
  const upload = stepAfterBrowserTests();
  assert.match(upload, /^ +if-no-files-found: ignore$/m);
  const days = Number(upload.match(/^ +retention-days: (\d+)$/m)?.[1]);
  assert.ok(days >= 1 && days <= MAX_RETENTION_DAYS, `retention-days is ${days}`);
});
