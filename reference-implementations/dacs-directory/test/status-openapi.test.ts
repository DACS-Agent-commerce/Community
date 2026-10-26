import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as status } from "../app/api/dacs/status/route.js";
import { GET as openapi } from "../app/openapi.json/route.js";
import { recordListingRejection } from "../src/catalog/store.js";
import { LISTING_REJECTION_CODES } from "../src/catalog/listingAdmission.js";

type Schema = {
  type?: string | string[]; const?: unknown; enum?: unknown[]; required?: string[];
  properties?: Record<string, Schema>; additionalProperties?: boolean | Schema;
  items?: Schema; $ref?: string; minimum?: number; maximum?: number; maxItems?: number; pattern?: string;
};

// Validate the diagnostic subtree's object/array/scalar schema vocabulary.
// The schema comes from the HTTP endpoint, and the values come from SQLite
// through the real status route, so neither side is a hand-written fixture.
function validate(value: unknown, schema: Schema, components: Record<string, Schema>): void {
  if (schema.$ref) return validate(value, components[schema.$ref.split("/").at(-1)!], components);
  if ("const" in schema) assert.deepEqual(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    assert.ok(types.includes(type) || (types.includes("integer") && Number.isInteger(value)), `expected ${types}, got ${type}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum);
  }
  if (typeof value === "string" && schema.pattern) assert.match(value, new RegExp(schema.pattern));
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems);
    if (schema.items) for (const item of value) validate(item, schema.items, components);
  } else if (value !== null && typeof value === "object") {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `missing ${key}`);
    for (const [key, member] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) validate(member, child, components);
      else if (schema.additionalProperties === false) assert.fail(`unexpected ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validate(member, schema.additionalProperties, components);
    }
  }
}

test("served OpenAPI accepts actual status rejection rows, including public notices and recovery guidance", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  for (const [index, code] of LISTING_REJECTION_CODES.entries()) {
    for (const [variant, coordinates, publicNotice] of [
      [0, undefined, false],
      [1, { listingId: `service-${index}`, listingVersion: 1 }, false],
      [2, { listingId: `service-${index}`, listingVersion: 1 }, true],
    ] as const) {
      recordListingRejection(`stor-${(index * 3 + variant).toString(16).padStart(40, "0")}`,
        `did:demos:agent:${"1".repeat(64)}`, code, coordinates, publicNotice);
    }
  }
  const response = await status(new NextRequest("https://directory.example/api/dacs/status?deadLetterLimit=100"));
  assert.equal(response.status, 200);
  const body = await response.json();
  const document = await (await openapi(new NextRequest("https://directory.example/openapi.json"))).json();
  const components = document.components.schemas as Record<string, Schema>;
  const contract = components.CatalogStatus.properties!.indexer.properties!.listingRejectionDiagnostics;
  const diagnostics = body.indexer.listingRejectionDiagnostics;
  assert.equal(diagnostics.total, LISTING_REJECTION_CODES.length * 3);
  assert.equal(diagnostics.publicTotal, LISTING_REJECTION_CODES.length);
  assert.equal(diagnostics.returned, diagnostics.total);
  assert.equal(diagnostics.hasMore, false);
  assert.deepEqual(new Set(diagnostics.items.map((row: { code: string }) => row.code)), new Set(LISTING_REJECTION_CODES));
  assert.ok(diagnostics.items.some((row: object) => !Object.hasOwn(row, "listingId")));
  assert.deepEqual(new Set(diagnostics.items.map((row: { publicNotice: boolean }) => row.publicNotice)), new Set([true, false]));
  validate(diagnostics, contract, components);
  // Guard the contract's requiredness and field types, in addition to acceptance.
  for (const field of ["publicNotice", "guidance"]) {
    const row = { ...diagnostics.items[0] };
    delete row[field];
    assert.throws(() => validate(row, components.ListingRejectionDiagnostic, components));
    row[field] = 7;
    assert.throws(() => validate(row, components.ListingRejectionDiagnostic, components));
  }
  const withoutCount = { ...diagnostics }; delete withoutCount.publicTotal;
  assert.throws(() => validate(withoutCount, contract, components));
  validate(body.legacyVetUnsupportedDeals, components.CatalogStatus.properties!.legacyVetUnsupportedDeals, components);
});
