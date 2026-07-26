import assert from "node:assert/strict";
import test from "node:test";
import { pricingModelLabel } from "../src/components/labels.js";

test("pricing label reflects the structured pricing model, not the negotiation pattern", () => {
  // The core fix: a negotiable-band listing that fronts negotiate-fixed-price
  // must read as its real pricing model, not "fixed price".
  assert.equal(pricingModelLabel({ kind: "negotiable" }, ["negotiate-fixed-price"]), "negotiable band");
  assert.equal(pricingModelLabel({ kind: "fixed" }, ["negotiate-fixed-price"]), "fixed price");
  assert.equal(pricingModelLabel({ kind: "auction" }, ["negotiate-sealed-envelope"]), "sealed-envelope auction");
  assert.equal(pricingModelLabel({ kind: "metered" }, undefined), "metered");
});

test("pricing label falls back to an honest negotiation basis for legacy listings", () => {
  // No structured pricing.kind → describe the negotiation pattern, clearly
  // marked as such rather than dressed up as a stated price.
  assert.equal(pricingModelLabel(undefined, ["negotiate-fixed-price"]), "by negotiation (fixed price)");
  assert.equal(pricingModelLabel({}, ["negotiate-rfq", "negotiate-sealed-bid"]), "by negotiation (RFQ, sealed bid)");
  assert.equal(pricingModelLabel(undefined, undefined), "Not stated");
  // supportedNegotiation: [] normalizes to an empty array, not undefined.
  assert.equal(pricingModelLabel({}, []), "Not stated");
  // An unknown future pricing.kind is ignored in favor of the honest fallback.
  assert.equal(pricingModelLabel({ kind: "surge" }, ["negotiate-rfq"]), "by negotiation (RFQ)");
});
