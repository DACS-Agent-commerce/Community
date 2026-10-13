export const GATEWAY_DEMO_RECOVERY_MESSAGE =
  "New purchases are paused while the buyer demo moves to its gateway-owned origin. Existing runs whose gateway job id this browser received can still be checked and resumed; a run without one is never re-sent and goes to manual reconciliation.";

/**
 * Shown when a drain-mode resume finds a record without a job id: the
 * original POST may never have reached the gateway, so re-sending it could
 * start a new paid purchase that the drain's reconciliation never sees.
 */
export function gatewayDemoManualReconcileMessage(runId: string): string {
  return `This run's gateway job id was never received, and new purchases are paused during the demo move, so nothing was sent: re-sending it could start a new paid purchase. Give the operator run id ${runId} to reconcile it, then dismiss this reminder.`;
}

/** Build-time drain control for the retiring Community-hosted buyer demo. */
export function gatewayDemoRecoveryOnly(value = process.env.NEXT_PUBLIC_GATEWAY_DEMO_RECOVERY_ONLY): boolean {
  return value === "1";
}
