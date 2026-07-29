const DEFAULT_PUBLIC_DEMOS_RPC = "https://demosnode.discus.sh";

/**
 * Return the Demos endpoint that is safe to advertise to catalog consumers.
 *
 * This intentionally never falls back to DEMOS_RPC: that variable may name an
 * internal deployment endpoint. Operators must opt an endpoint into the
 * public machine contract with NEXT_PUBLIC_DEMOS_RPC.
 */
export function publicDemosRpcUrl(configured = process.env.NEXT_PUBLIC_DEMOS_RPC): string {
  const raw = configured?.trim() || DEFAULT_PUBLIC_DEMOS_RPC;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("NEXT_PUBLIC_DEMOS_RPC must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("NEXT_PUBLIC_DEMOS_RPC must be a credential-free HTTPS origin without query or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

