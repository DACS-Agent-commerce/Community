import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { FixtureNode } from "./fixtures/kit-listing.js";

// The testnet deployment (deploy/testnet) refuses any network but the Demos
// testnet before the web server or an index pass starts.
const profile = {
  DACS_DIRECTORY_NETWORK: "testnet",
  DEMOS_RPC: "https://rpc.testnet.example.org",
  NEXT_PUBLIC_DEMOS_RPC: "https://rpc.testnet.example.org",
};
Object.assign(process.env, profile);
delete process.env.DEMOS_CHAIN_IDENTITY;
const node = new FixtureNode();
globalThis.fetch = node.fetch;
const { checkTestnetStartup, testnetConfigRefusal, TESTNET_CHAIN_IDENTITIES } = await import("../src/catalog/testnetDeployment.js");

const deployFile = (name: string) => readFileSync(new URL(`../deploy/testnet/${name}`, import.meta.url), "utf8");
const envExample = () => Object.fromEntries(deployFile("directory.env.example").split("\n")
  .filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

test("the profile refuses every network label but testnet, mainnet included", () => {
  for (const network of [undefined, "", "mainnet", "devnet", "Testnet"]) {
    const refusal = testnetConfigRefusal({ ...profile, DACS_DIRECTORY_NETWORK: network });
    assert.match(String(refusal), /DACS_DIRECTORY_NETWORK must be "testnet"/, String(network));
  }
  assert.equal(testnetConfigRefusal(profile), null);
});

test("an RPC that names mainnet, is not https, carries a user or is missing is refused", () => {
  for (const [name, value, reason] of [
    ["DEMOS_RPC", "https://rpc.mainnet.example.org", /names a mainnet host/],
    ["NEXT_PUBLIC_DEMOS_RPC", "https://mainnet-rpc.example.org", /names a mainnet host/],
    ["DEMOS_RPC", "http://rpc.testnet.example.org", /credential-free https URL/],
    ["DEMOS_RPC", "https://operator@rpc.testnet.example.org", /credential-free https URL/],
    ["NEXT_PUBLIC_DEMOS_RPC", undefined, /must name the testnet RPC/],
    ["DEMOS_RPC", "rpc.testnet.example.org", /absolute https URL/],
  ] as const) {
    assert.match(String(testnetConfigRefusal({ ...profile, [name]: value })), reason, `${name}=${value}`);
  }
});

test("a configured chain identity that is not a reviewed testnet identity is refused", () => {
  assert.match(String(testnetConfigRefusal({ ...profile, DEMOS_CHAIN_IDENTITY: "ab".repeat(32) })),
    /not a reviewed testnet chain identity/);
  assert.equal(testnetConfigRefusal({ ...profile, DEMOS_CHAIN_IDENTITY: TESTNET_CHAIN_IDENTITIES[0].toUpperCase() }), null);
});

test("startup refuses a node that serves another chain", async () => {
  node.chainIdentity = "cd".repeat(32);
  try {
    const result = await checkTestnetStartup();
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, new RegExp(`serves chain ${"cd".repeat(32)}, not the pinned chain`));
  } finally {
    node.chainIdentity = TESTNET_CHAIN_IDENTITIES[0];
  }
});

test("startup refuses a node it cannot read and names that cause", async () => {
  node.down = true;
  try {
    const result = await checkTestnetStartup();
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /^could not read the Demos node's chain/);
  } finally {
    node.down = false;
  }
});

test("startup accepts the testnet profile on the reviewed testnet chain", async () => {
  assert.deepEqual(await checkTestnetStartup(), { ok: true, chainIdentity: TESTNET_CHAIN_IDENTITIES[0] });
});

test("the startup script exits non-zero on a mainnet profile before contacting a node", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-testnet-deployment.ts"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, ...profile, DACS_DIRECTORY_NETWORK: "mainnet" },
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /refusing to start: DACS_DIRECTORY_NETWORK must be "testnet"/);
});

test("the index timer fires every five minutes and both units run the startup check before starting", () => {
  assert.match(deployFile("dacs-directory-index.timer"), /^OnCalendar=\*:0\/5$/m);
  assert.match(deployFile("dacs-directory-index.timer"), /^Unit=dacs-directory-index\.service$/m);
  assert.equal(envExample().DACS_INDEX_INTERVAL_SECONDS, "300", "status diagnostics use the timer's interval");
  for (const unit of ["dacs-directory.service", "dacs-directory-index.service"]) {
    const text = deployFile(unit);
    const check = text.search(/^ExecStartPre=\/usr\/bin\/env npm run --silent check:testnet$/m);
    assert.ok(check >= 0 && check < text.search(/^ExecStart=/m), unit);
    assert.match(text, /^EnvironmentFile=\/etc\/dacs-directory\/directory\.env$/m, unit);
  }
  assert.match(deployFile("dacs-directory-index.service"), /^ExecStart=\/usr\/bin\/env npm run --silent index$/m);
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  assert.equal(scripts["check:testnet"], "tsx scripts/check-testnet-deployment.ts");
});

test("the env example is the testnet profile, with example.org placeholders and no secret", () => {
  const env = envExample();
  assert.equal(testnetConfigRefusal(env), null);
  assert.equal(env.DACS_ADMIN_TOKEN, "", "the admin token is generated on the server, never committed");
  for (const name of readdirSync(new URL("../deploy/testnet/", import.meta.url))) {
    for (const host of deployFile(name).match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?=[/:\s]|$)/gim) ?? []) {
      if (/\.(?:service|timer|target|env|md|example|json|ts|mjs|sh)$/i.test(host)) continue;
      assert.match(host, /(?:^|\.)example\.org$/i, `${name}: ${host}`);
    }
  }
});
