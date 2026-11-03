import assert from "node:assert/strict";
import test from "node:test";
import { negotiablePriceBand } from "@kynesyslabs/dacs/negotiate";
import { negotiationBandFloorError } from "../src/catalog/negotiationBandFloor.js";

const CENTRES = ["1", "2", "3", "0.01", "0.05", "1.25", "99.99", "100", "100.000000000000000001", "123456789012345678901234567890"];
const PERCENTS = [0, 1, 20, 33, 49, 50, 51, 66, 67, 98, 99, 2.5, 49.5, 50.5, 99.5, 99.9, 99.99, 1e-7, 99.999999];

const sdkAcceptsFloor = (amount: string, minPct: number) => {
  try {
    negotiablePriceBand({ kind: "negotiable", bandCenter: { amount, currency: "DEM" }, minPct, maxPct: 0 });
    return true;
  } catch { return false; }
};

test("band floor check gives the SDK's verdict for every centre and percentage in the grid", () => {
  for (const amount of CENTRES) {
    for (const minPct of PERCENTS) {
      assert.equal(negotiationBandFloorError({ amount }, minPct) === undefined, sdkAcceptsFloor(amount, minPct), `${amount} @ ${minPct}%`);
    }
  }
});

test("band floor check rounds half-up at the centre's precision, so 1 @ 50% passes and 1 @ 51% fails", () => {
  assert.equal(negotiationBandFloorError({ amount: "1" }, 50), undefined);
  assert.match(negotiationBandFloorError({ amount: "1" }, 51) ?? "", /rounds to zero/);
  assert.equal(negotiationBandFloorError({ amount: "0.01" }, 50), undefined);
  assert.match(negotiationBandFloorError({ amount: "0.01" }, 51) ?? "", /rounds to zero/);
});

test("band floor check refuses a malformed centre or a percentage outside 0 up to 100", () => {
  for (const [amount, minPct] of [["0", 10], ["01", 10], ["1.0", 10], ["", 10], ["1e3", 10], ["1", -1], ["1", 100], ["1", Number.NaN], ["1", Infinity]] as const) {
    assert.notEqual(negotiationBandFloorError({ amount }, minPct), undefined, `${amount} @ ${minPct}`);
  }
});
