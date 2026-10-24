import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";
import { registerLegacyListingHashCases } from "./fixtures/legacy-listing-hash-cases.js";

const digest = (preimage: string) => createHash("sha256").update(preimage, "utf8").digest("hex");

registerLegacyListingHashCases(test, assert, legacyListingHash, digest);
