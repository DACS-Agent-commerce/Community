export const GATEWAY_DEMO_RECOVERY_MESSAGE =
  "New purchases are paused while the buyer demo moves to its gateway-owned origin. Existing runs can still be checked and resumed with their original idempotency key.";

/** Build-time drain control for the retiring Community-hosted buyer demo. */
export function gatewayDemoRecoveryOnly(value = process.env.NEXT_PUBLIC_GATEWAY_DEMO_RECOVERY_ONLY): boolean {
  return value === "1";
}
