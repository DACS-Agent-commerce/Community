import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { registrationMessage } from "../src/catalog/registrationSig.js";

const { POST } = await import("../app/api/dacs/prepare-registration/route.js");
const registration = {
  primaryClaim: `did:demos:agent:${"12".repeat(32)}`,
  displayName: "Recoverable seller",
  listingAnchors: [`stor-${"34".repeat(20)}`],
  deals: [],
};
const request = (body: Record<string, unknown>) => new NextRequest(
  "https://directory.example/api/dacs/prepare-registration",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);

test("prepare-registration issues a fresh content-bound signing message", async () => {
  const before = Date.now();
  const response = await POST(request(registration));
  const after = Date.now();
  assert.equal(response.status, 200);
  const body = await response.json() as {
    registration: typeof registration & { ownerSignature: { message: string; signedAt: number } };
  };
  assert.ok(body.registration.ownerSignature.signedAt >= before);
  assert.ok(body.registration.ownerSignature.signedAt <= after);
  assert.equal(
    body.registration.ownerSignature.message,
    registrationMessage(registration, body.registration.ownerSignature.signedAt),
  );
});

test("prepare-registration rejects a caller-supplied owner signature", async () => {
  const response = await POST(request({
    ...registration,
    ownerSignature: { message: "attacker", signature: "00", signedAt: Date.now() },
  }));
  assert.equal(response.status, 400);
  assert.match(String((await response.json()).error), /unsigned registration/);
});
