const MAX_PUBLIC_ENDPOINT_LENGTH = 2048;

/** Signed content is authentic, not automatically safe to place in an href. */
export function safePublicEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PUBLIC_ENDPOINT_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
