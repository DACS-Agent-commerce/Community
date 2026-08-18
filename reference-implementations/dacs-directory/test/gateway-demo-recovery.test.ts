import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_DEMO_RECOVERY_MESSAGE,
  gatewayDemoRecoveryOnly,
} from "../src/components/gateway-demo-recovery.js";

test("gateway demo drain is opt-in and exact", () => {
  assert.equal(gatewayDemoRecoveryOnly(undefined), false);
  assert.equal(gatewayDemoRecoveryOnly("0"), false);
  assert.equal(gatewayDemoRecoveryOnly("true"), false);
  assert.equal(gatewayDemoRecoveryOnly("1"), true);
  assert.match(GATEWAY_DEMO_RECOVERY_MESSAGE, /Existing runs can still be checked and resumed/);
});
