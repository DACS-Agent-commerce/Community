import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import * as React from "react";

import { ListingRejectionNotice, type ListingRejectionDiagnostics } from "../src/components/CatalogStatus.js";

// The app has no react-dom type package; this is the one function the test uses.
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup: (element: React.ReactElement) => string;
};

// tsconfig keeps JSX as written for Next, so tsx compiles the component with the
// classic runtime, which calls the global React.
Object.assign(globalThis, { React });

const STATUS_PAGE_SIZE = 20;

const notices = (count: number, publicNotice = true): ListingRejectionDiagnostics["items"] =>
  Array.from({ length: count }, (_, index) => ({
    locator: `stor-${index.toString(16).padStart(40, "0")}`, code: "OWNER_CLAIM_BINDING", publicNotice,
    message: "The listing anchor owner does not match the registration claim.", guidance: "Correct the pointer.",
  }));

const render = (rejected: ListingRejectionDiagnostics) => renderToStaticMarkup(React.createElement(ListingRejectionNotice, { rejected }));

test("the notice says how many public notices exist when the status reply lists fewer", () => {
  const markup = render({ total: 25, publicTotal: 21, items: notices(STATUS_PAGE_SIZE) });
  assert.match(markup, /21 listing pointers could not be indexed/);
  assert.match(markup, /Showing 20 of 21/);
  assert.match(markup, /href="\/api\/dacs\/status\?deadLetterLimit=100"/);
});

test("the notice lists every public notice without a truncation line when the reply has them all", () => {
  const markup = render({ total: 3, publicTotal: 2, items: [...notices(2), ...notices(1, false)] });
  assert.equal(markup.match(/<li>/g)?.length, 2);
  assert.doesNotMatch(markup, /Showing/);
});

test("the notice renders nothing when no owner-signed pointer failed", () => {
  assert.equal(render({ total: 4, publicTotal: 0, items: notices(4, false) }), "");
});

test("a retained publisher hash notice describes unresolved pointers from an earlier pass", () => {
  const markup = render({ total: 1, publicTotal: 1, items: [{
    locator: `stor-${"a".repeat(40)}`, listingId: "publisher-service", listingVersion: 1,
    code: "DECLARED_CONTENT_HASH_MISMATCH", publicNotice: true,
    message: "The declared hash does not match the verified artifact.", guidance: "Correct the declared hash.",
  }] });
  assert.match(markup, /1 listing pointer could not be indexed/);
  assert.match(markup, /Unresolved diagnostics may be retained from an earlier indexing pass/);
  assert.match(markup, /publisher-authenticated hash declarations/);
  assert.doesNotMatch(markup, /owner-submitted|latest indexing pass/);
});
