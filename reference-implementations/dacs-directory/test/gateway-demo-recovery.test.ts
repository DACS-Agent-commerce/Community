import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_DEMO_RECOVERY_MESSAGE,
  gatewayDemoManualReconcileMessage,
  gatewayDemoRecoveryOnly,
} from "../src/components/gateway-demo-recovery.js";

test("gateway demo drain is opt-in and exact", () => {
  assert.equal(gatewayDemoRecoveryOnly(undefined), false);
  assert.equal(gatewayDemoRecoveryOnly("0"), false);
  assert.equal(gatewayDemoRecoveryOnly("true"), false);
  assert.equal(gatewayDemoRecoveryOnly("1"), true);
  assert.match(GATEWAY_DEMO_RECOVERY_MESSAGE, /can still be checked and resumed/);
  assert.match(GATEWAY_DEMO_RECOVERY_MESSAGE, /never re-sent/);
});

test("a drain-mode run without a job id is handed to the operator by run id", () => {
  const text = gatewayDemoManualReconcileMessage("run-without-job");
  assert.match(text, /run id run-without-job/);
  assert.match(text, /nothing was sent/);
});
