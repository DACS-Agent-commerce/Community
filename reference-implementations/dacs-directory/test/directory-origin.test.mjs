import assert from "node:assert/strict";
import test from "node:test";

import { checkDirectoryOrigin, httpsOrigin } from "../scripts/check-directory-origin.mjs";

test("accepts and canonicalizes a production HTTPS directory origin", () => {
  assert.equal(
    httpsOrigin({ NEXT_PUBLIC_DIRECTORY_URL: "https://directory.example/" }, "NEXT_PUBLIC_DIRECTORY_URL"),
    "https://directory.example",
  );
  assert.equal(
    checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: "https://directory.example" } }),
    "Production directory origin valid: https://directory.example",
  );
  for (const value of [
    "https://directory.example:8443",
    "https://8.8.8.8",
    "https://172.32.0.1",
    "https://[2606:4700::1111]",
    "https://localhost-directory.example",
    "https://directory.local.example",
  ]) {
    assert.equal(httpsOrigin({ NEXT_PUBLIC_DIRECTORY_URL: value }, "NEXT_PUBLIC_DIRECTORY_URL"), value);
  }
});

test("rejects missing, insecure, or non-origin deployment URLs", () => {
  assert.throws(
    () => checkDirectoryOrigin({ env: {} }),
    /NEXT_PUBLIC_DIRECTORY_URL is required/,
  );
  assert.throws(
    () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: "http://directory.example" } }),
    /NEXT_PUBLIC_DIRECTORY_URL must use HTTPS/,
  );
  for (const value of [
    "https://user@directory.example",
    "https://:secret@directory.example",
    "https://directory.example/path",
    "https://directory.example?mode=test",
    "https://directory.example#fragment",
  ]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must be an origin without credentials, path, query, or fragment/,
      value,
    );
  }
});

// The app reads the raw variable (src/catalog/publicUrl.ts), so a value that only
// parses to a valid origin would still leak into canonical URLs and the sitemap.
test("rejects values that the app would not use verbatim as the origin", () => {
  for (const value of [
    " https://directory.example",
    "https://directory.example/ ",
    "https://directory.example?",
    "https://directory.example/#",
    "https://DIRECTORY.example",
    "https://directory.example:443",
  ]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must be written exactly as its origin/,
      value,
    );
  }
});

test("rejects loopback, unspecified, private, and local-only hosts", () => {
  for (const value of [
    "https://localhost",
    "https://localhost/",
    "https://localhost.",
    "https://directory.localhost",
    "https://127.0.0.1",
    "https://127.8.9.10",
    "https://0.0.0.0",
    "https://[::1]",
    "https://[::]",
    "https://[::ffff:7f00:1]",
    "https://10.1.2.3",
    "https://172.16.0.1",
    "https://172.31.255.254",
    "https://192.168.1.10",
    "https://169.254.169.254",
    "https://100.64.0.1",
    "https://[fe80::1]",
    "https://[fd00::1]",
    "https://directory.local",
    "https://directory.local.",
  ]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must be a public host/,
      value,
    );
  }
});
