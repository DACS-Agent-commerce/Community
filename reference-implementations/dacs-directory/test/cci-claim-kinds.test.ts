import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-directory-cci-kinds-"));
const { indexRegistration } = await import("../src/catalog/indexer.js");

const primaryClaim = `did:demos:agent:${"ab".repeat(32)}`;

test("CCI badges list only web2 and wallet claims, not the other kinds the SDK parses", async () => {
  const identities = { response: {
    web2: { github: [{ username: "octo-seller", proof: "https://gist.github.com/octo-seller/1" }] },
    xm: { evm: { mainnet: [{ address: "0x1234" }] } },
    ud: [{ domain: "seller.crypto" }],
    pqc: { falcon: [{ address: "falcon-address" }] },
  } };
  const record = await indexRegistration({ primaryClaim, displayName: "Seller", listingAnchors: [] }, undefined, async () => identities);
  assert.deepEqual(record.cci.map(({ kind, platform, handle }) => ({ kind, platform, handle })), [
    { kind: "web2", platform: "github", handle: "octo-seller" },
    { kind: "wallet", platform: "evm", handle: "0x1234" },
  ]);
});
