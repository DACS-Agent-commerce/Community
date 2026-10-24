import assert from "node:assert/strict";
import test from "node:test";
test("diagnostic coordinates preserve current precedence and validate the legacy fallback", async () => {
  const { listingDiagnosticCoordinates: coordinates } = await import("../src/catalog/listingAdmission.js");
  assert.deepEqual(coordinates({ serviceId: "legacy", version: 3 }), { listingId: "legacy", listingVersion: 3 });
  assert.deepEqual(coordinates({ serviceId: "legacy" }), { listingId: "legacy", listingVersion: 1 });
  assert.deepEqual(coordinates({ listingId: "current", listingVersion: 2, serviceId: "legacy", version: 3 }),
    { listingId: "current", listingVersion: 2 });
  for (const raw of [{ serviceId: 123 }, { serviceId: "legacy", version: 0 },
    { serviceId: "legacy", version: -1 }, { listingId: "", serviceId: "legacy" }]) {
    assert.equal(coordinates(raw), undefined);
  }
});

