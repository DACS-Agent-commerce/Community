import assert from "node:assert/strict";
import test from "node:test";

import { checkDirectoryOrigin, httpsOrigin } from "../scripts/check-directory-origin.mjs";

test("accepts and canonicalizes a production HTTPS directory origin", () => {
  assert.equal(
    httpsOrigin({ NEXT_PUBLIC_DIRECTORY_URL: " https://directory.example/ " }, "NEXT_PUBLIC_DIRECTORY_URL"),
    "https://directory.example",
  );
  assert.equal(
    checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: "https://directory.example" } }),
    "Production directory origin valid: https://directory.example",
  );
});

test("rejects missing, insecure, or non-origin deployment URLs", () => {
  assert.throws(
    () => checkDirectoryOrigin({ env: {} }),
    /NEXT_PUBLIC_DIRECTORY_URL is required/,
  );
  for (const value of [
    "http://directory.example",
    "https://user@directory.example",
    "https://directory.example/path",
    "https://directory.example?mode=test",
    "https://directory.example#fragment",
  ]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must/,
    );
  }
});
