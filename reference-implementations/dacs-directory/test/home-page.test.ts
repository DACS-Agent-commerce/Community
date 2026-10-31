import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as React from "react";

import type { Catalog } from "../src/catalog/types.js";

// The app has no react-dom type package; this is the one function the test uses.
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup: (element: React.ReactElement) => string;
};

// tsconfig keeps JSX as written for Next, so tsx compiles app/page.tsx with the
// classic runtime, which calls the global React.
Object.assign(globalThis, { React });

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MINUTE = 60_000;

// Only the fields the summary reads, as in home-hero-state.test.ts.
function catalog(generatedAt: number, sellers: Array<{ statuses: string[]; deals: boolean[] }>): Catalog {
  return {
    catalogVersion: "1",
    generatedAt,
    sellers: sellers.map(({ statuses, deals }) => ({
      listings: statuses.map((status) => ({ status })),
      deals: deals.map((refsVerified) => ({ refsVerified })),
    })),
  } as unknown as Catalog;
}

// The four value/label pairs of the summary strip, in page order.
function summaryStrip(html: string): string[][] {
  const strip = html.match(/<div class="trust-strip" aria-label="Catalog summary">(.*?)<\/div><\/div>/);
  assert.ok(strip, "the homepage renders its catalog summary strip");
  return [...`${strip[1]}</div>`.matchAll(/<div><strong>([^<]*)<\/strong><span>([^<]*)<\/span><\/div>/g)]
    .map(([, value, label]) => [value, label]);
}

test("the homepage renders the stored catalog's summary and links only Directory pages", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "home-page-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  process.env.DACS_DIRECTORY_DATA = data;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { saveCatalog } = await import("../src/catalog/store.js");
  const { default: Home, metadata } = await import("../app/page.js");
  const render = () => renderToStaticMarkup(React.createElement(Home));

  assert.deepEqual(summaryStrip(render()), [
    ["0", "active services"],
    ["0", "indexed sellers"],
    ["0", "signature-checked bundles; not counted as outcomes"],
    ["pending", "initial chain index"],
  ]);

  saveCatalog(catalog(NOW - 5 * MINUTE, [{ statuses: ["revoked"], deals: [true] }]));
  assert.deepEqual(summaryStrip(render()), [
    ["0", "active services"],
    ["0", "indexed sellers"],
    ["0", "signature-checked bundles; not counted as outcomes"],
    ["5m", "last index; no active listings"],
  ]);

  // Every value differs, so a field bound to the wrong stat shows up.
  saveCatalog(catalog(NOW - 7 * MINUTE, [
    { statuses: ["active", "active", "active", "revoked"], deals: [true, false, true] },
    { statuses: ["active", "active"], deals: [true, false] },
    { statuses: ["revoked"], deals: [true, true] },
  ]));
  const html = render();
  assert.deepEqual(summaryStrip(html), [
    ["5", "active services"],
    ["2", "indexed sellers"],
    ["3", "signature-checked bundles; not counted as outcomes"],
    ["7m", "since last index"],
  ]);
  assert.doesNotMatch(html, /observed bundles|verified deal graphs|\d+(?:\.\d+)?\s*(?:%|stars|rating|score)/i);

  assert.deepEqual([...html.matchAll(/ href="([^"]*)"/g)].map(([, href]) => href), [
    "/discover",
    "/register",
    "/how-it-works",
    "/discover",
    "/verify",
    "/api/dacs",
    "/register",
    "/.well-known/dacs-directory.json",
  ]);
  assert.deepEqual(metadata.alternates, { canonical: "/" });
});
