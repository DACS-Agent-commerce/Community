import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkDirectoryOrigin, httpsOrigin } from "../scripts/check-directory-origin.mjs";

function assertPublic(value) {
  assert.equal(httpsOrigin({ NEXT_PUBLIC_DIRECTORY_URL: value }, "NEXT_PUBLIC_DIRECTORY_URL"), value);
}

function assertNotPublic(value) {
  assert.throws(
    () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
    /NEXT_PUBLIC_DIRECTORY_URL must be a public host/,
    value,
  );
}

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
    "https://directory.example.",
    "https://8.8.8.8",
    "https://172.32.0.1",
    "https://[2606:4700::1111]",
    "https://[::ffff:808:808]",
    "https://localhost-directory.example",
    "https://directory.local.example",
    "https://directory.notlocal",
    "https://directory.notinternal",
  ]) assertPublic(value);
});

// The nearest public neighbours of each blocked range, so no range can grow.
test("accepts public addresses next to each blocked range", () => {
  for (const value of [
    "https://1.1.1.1",
    "https://11.0.0.0",
    "https://100.63.255.255",
    "https://100.128.0.0",
    "https://126.255.255.255",
    "https://128.0.0.0",
    "https://169.253.255.255",
    "https://169.255.0.0",
    "https://172.15.255.255",
    "https://192.0.1.1",
    "https://192.0.3.0",
    "https://192.88.98.255",
    "https://192.88.100.0",
    "https://192.167.255.255",
    "https://192.169.0.0",
    "https://198.17.255.255",
    "https://198.20.0.1",
    "https://198.51.99.255",
    "https://198.51.101.0",
    "https://203.0.112.255",
    "https://203.0.114.0",
    "https://223.255.255.255",
    "https://[2000::1]",
    "https://[2001:200::1]",
    "https://[2001:db7:ffff::1]",
    "https://[2001:db9::1]",
    "https://[2003::1]",
    "https://[3fff:1000::1]",
    "https://[3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[::ffff:dfff:ffff]",
  ]) assertPublic(value);
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
    "https://0.1.2.3",
    "https://[::1]",
    "https://[::]",
    "https://[::ffff:7f00:1]",
    "https://10.1.2.3",
    "https://172.16.0.1",
    "https://172.31.255.254",
    "https://192.168.1.10",
    "https://169.254.169.254",
    "https://100.64.0.1",
    "https://100.127.255.255",
    "https://[fe80::1]",
    "https://[febf::1]",
    "https://[fd00::1]",
    "https://directory.local",
    "https://directory.local.",
  ]) assertNotPublic(value);
});

test("rejects single-label, malformed, and private-use names", () => {
  for (const value of [
    "https://directory",
    "https://local",
    "https://ip6-localhost",
    "https://.",
    "https://localhost..",
    "https://directory.local..",
    "https://directory.example..",
    "https://directory..example",
    "https://directory.internal",
    "https://directory.railway.internal",
    "https://router.home.arpa",
    "https://localhost.localdomain",
  ]) assertNotPublic(value);
});

// Only globally routable unicast literals can be this deployment's public origin.
test("rejects special-use, documentation, multicast, and reserved IP literals", () => {
  for (const value of [
    "https://192.0.0.192",
    "https://192.0.2.1",
    "https://192.88.99.1",
    "https://198.18.0.1",
    "https://198.19.255.255",
    "https://198.51.100.1",
    "https://203.0.113.1",
    "https://224.0.0.1",
    "https://239.255.255.255",
    "https://240.0.0.1",
    "https://255.255.255.255",
    "https://[::ffff:192.0.2.1]",
    "https://[::ffff:224.0.0.1]",
    "https://[2001:db8::1]",
    "https://[3fff::1]",
    "https://[3fff:fff::1]",
    "https://[2001::1]",
    "https://[2001:1ff::1]",
    "https://[fec0::1]",
    "https://[ff02::1]",
    "https://[100::1]",
    "https://[1fff:ffff::1]",
    "https://[4000::1]",
  ]) assertNotPublic(value);
});

// The last address inside each blocked range, so no range can shrink. The
// ::fffe: address sits just below the IPv4-mapped block, so that block can't grow.
test("rejects the upper edge of each blocked range", () => {
  for (const value of [
    "https://0.255.255.255",
    "https://10.255.255.255",
    "https://127.255.255.255",
    "https://169.254.255.255",
    "https://172.31.255.255",
    "https://192.0.0.255",
    "https://192.0.2.255",
    "https://192.88.99.255",
    "https://192.168.255.255",
    "https://198.51.100.255",
    "https://203.0.113.255",
    "https://[1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[2001:db8:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[::fffe:808:808]",
  ]) assertNotPublic(value);
});

// Transition prefixes carry an IPv4 address the check would otherwise not classify.
test("rejects IPv6 transition forms that embed an IPv4 address", () => {
  for (const value of [
    "https://[64:ff9b::7f00:1]",
    "https://[64:ff9b:1::a00:1]",
    "https://[2002:7f00:1::]",
    "https://[2002:808:808::1]",
    "https://[::7f00:1]",
    "https://[::ffff:0:7f00:1]",
  ]) assertNotPublic(value);
});

// docs/codex-local-workflow.md reruns CI's origin check and build locally, so
// every origin it passes must be CI's own value, and that value must pass.
test("the local verification guide passes only CI's placeholder origin", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const ciEnv = Object.fromEntries(
    [...read("../../../.github/workflows/dacs-directory-ci.yml").matchAll(/^ +(NEXT_PUBLIC_\w+): (\S+)$/gm)]
      .map(([, name, value]) => [name, value]),
  );
  assert.equal(
    checkDirectoryOrigin({ env: ciEnv }),
    `Production directory origin valid: ${ciEnv.NEXT_PUBLIC_DIRECTORY_URL}`,
  );

  const guide = read("../../../docs/codex-local-workflow.md");
  const assignments = [...guide.matchAll(/\b(NEXT_PUBLIC_\w+)=(\S+)/g)];
  assert.ok(assignments.length > 0, "the guide no longer passes an origin to the checks");
  for (const [, name, value] of assignments) assert.equal(value, ciEnv[name], name);
  // The retired gateway demo's Butler origin and live/paid browser suite.
  assert.doesNotMatch(guide, /butler|live_paid|live\/paid/i);
});
