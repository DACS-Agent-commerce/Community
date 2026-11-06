/** Deadline for one request VerifyDeal makes while it checks a deal. */
export const VERIFY_DEAL_REQUEST_TIMEOUT_MS = 15_000;

/** Shown in the verification result when a request misses its deadline. */
export const VERIFY_DEAL_TIMEOUT_MESSAGE = "The chain records took too long to answer. Try again in a moment.";

/** A request that did not finish within the deadline. */
export class VerifyDealTimeoutError extends Error {
  constructor() {
    super(VERIFY_DEAL_TIMEOUT_MESSAGE);
    this.name = "VerifyDealTimeoutError";
  }
}

const isTimeout = (error: unknown) => error instanceof DOMException && error.name === "TimeoutError";

/** One artifact read through `/api/dacs/artifact`. Rejects with a `VerifyDealTimeoutError` past the deadline. */
export async function fetchArtifact(params: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`/api/dacs/artifact?${params}`, { signal: AbortSignal.timeout(VERIFY_DEAL_REQUEST_TIMEOUT_MS) });
    const json = (await res.json()) as { value: Record<string, unknown> | null };
    return json.value ?? null;
  } catch (error) {
    if (isTimeout(error)) throw new VerifyDealTimeoutError();
    throw error;
  }
}

/**
 * The registered owners and anchor refs of a deal, or null when the directory cannot supply them.
 * A missed deadline is not "no registration": it rejects with a `VerifyDealTimeoutError`.
 */
export async function registeredBundleRefs(jobId: string, bundleRef: string): Promise<{
  owners: unknown;
  buyerBundleRef: unknown;
  sellerBundleRef: unknown;
} | null> {
  try {
    const res = await fetch(`/api/dacs/deal-owners?jobId=${encodeURIComponent(jobId)}&bundleRef=${encodeURIComponent(bundleRef)}`, {
      signal: AbortSignal.timeout(VERIFY_DEAL_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json() as { owners: unknown; buyerBundleRef: unknown; sellerBundleRef: unknown };
  } catch (error) {
    if (isTimeout(error)) throw new VerifyDealTimeoutError();
    return null;
  }
}
