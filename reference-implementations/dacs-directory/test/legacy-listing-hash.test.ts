import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";
import { canonicalize } from "../src/catalog/canonical.js";
import { registerLegacyListingHashCases } from "./fixtures/legacy-listing-hash-cases.js";

const digest = (preimage: string) => createHash("sha256").update(preimage, "utf8").digest("hex");

registerLegacyListingHashCases(test, assert, legacyListingHash, canonicalize, digest);
