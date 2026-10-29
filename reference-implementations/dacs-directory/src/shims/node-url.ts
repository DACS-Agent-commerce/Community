/**
 * Browser subset used by the SDK's pure verification modules: the WHATWG
 * domain conversions behind the SDK's DACS-1 DCR-1/DCR-2 hostname check.
 * Node implements both as WHATWG URL host parsing, which browsers expose
 * through `URL`. The SDK rejects URL structure (`:/@?#[]\%`, whitespace)
 * before calling them, so the input cannot change the URL's shape.
 */
export function domainToASCII(domain: string): string {
  try {
    return new URL(`http://${domain}/`).hostname;
  } catch {
    return "";
  }
}

/**
 * Browsers expose no Unicode host serialization. Only the SDK's producer path
 * (canonicalizing a native hostname) uses this; signed-artifact readers compare
 * against an ASCII result. Returning "" makes that producer path fail closed.
 */
export function domainToUnicode(_domain: string): string {
  return "";
}
