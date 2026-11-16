import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const APP_DIR = "reference-implementations/dacs-directory";
const MAX_RETENTION_DAYS = 14;

function reportLocations(configPath) {
  const config = read(configPath);
  const report = config.match(/\["html", \{ open: "never", outputFolder: "([^"]+)" \}\]/)?.[1];
  const output = config.match(/outputDir: "([^"]+)"/)?.[1];
  assert.ok(report, `${configPath} must write an HTML report without opening it`);
  assert.ok(output, `${configPath} must set an explicit outputDir`);
  return { report, output };
}

const configurations = [
  { path: "../playwright.config.ts", report: "playwright-report", output: "test-results/playwright" },
  { path: "../playwright.hash.config.ts", report: "playwright-report-hash", output: "test-results/hash" },
];

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

for (const { path, report, output } of configurations) {
  test(`${path} writes its own HTML report and test output`, () => {
    assert.deepEqual(reportLocations(path), { report, output });
  });
}

test("neither Playwright invocation cleans the other invocation's evidence", () => {
  const locations = configurations.flatMap(({ path }) => Object.values(reportLocations(path)));
  for (const [index, location] of locations.entries()) {
    for (const other of locations.slice(index + 1)) {
      assert.notEqual(location, other, "cleanup directories must differ");
      assert.ok(!location.startsWith(`${other}/`) && !other.startsWith(`${location}/`),
        `${location} and ${other} must not contain each other`);
    }
  }
});

// Upload paths are resolved from the repository root, not the run step's
// working-directory. A parent folder may cover both test-output directories.
test("uploads both runs' HTML reports and test-output directories", () => {
  const upload = stepAfterBrowserTests();
  const paths = [...upload.matchAll(/^ {12}(\S+)\/$/gm)].map(match => match[1]);
  for (const { path } of configurations) {
    for (const location of Object.values(reportLocations(path))) {
      const target = `${APP_DIR}/${location}`;
      assert.ok(paths.some(folder => target === folder || target.startsWith(`${folder}/`)),
        `the artifact must cover ${target}`);
    }
  }
});

test("uses a different artifact name for each run attempt", () => {
  assert.match(stepAfterBrowserTests(), /^ +name: browser-report-\$\{\{ github\.run_attempt \}\}$/m);
});

test("keeps artifacts briefly and ignores missing files", () => {
  const upload = stepAfterBrowserTests();
  assert.match(upload, /^ +if-no-files-found: ignore$/m);
  const days = Number(upload.match(/^ +retention-days: (\d+)$/m)?.[1]);
  assert.equal(days, 7, "preserve the existing seven-day retention");
  assert.ok(days >= 1 && days <= MAX_RETENTION_DAYS, `retention-days is ${days}`);
});
