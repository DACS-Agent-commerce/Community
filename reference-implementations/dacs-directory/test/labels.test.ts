import assert from "node:assert/strict";
import test from "node:test";
import { pricingModelLabel } from "../src/components/labels.js";

test("pricing labels describe the signed negotiation model without inventing an amount", () => {
  assert.equal(pricingModelLabel(["negotiate-fixed-price"]), "fixed price");
  assert.equal(
    pricingModelLabel(["negotiate-rfq", "negotiate-sealed-bid"]),
    "rfq, sealed bid",
  );
  assert.equal(pricingModelLabel(undefined), "not stated");
});
