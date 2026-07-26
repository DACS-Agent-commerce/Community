import assert from "node:assert/strict";
import test from "node:test";

import { homeCatalogDisplayState } from "../src/components/home-hero-state.js";

test("the homepage distinguishes indexing, indexed-empty, and populated catalogs", () => {
  assert.equal(homeCatalogDisplayState(false, 0), "indexing");
  assert.equal(homeCatalogDisplayState(true, 0), "empty");
  assert.equal(homeCatalogDisplayState(true, 1), "summary");
});
