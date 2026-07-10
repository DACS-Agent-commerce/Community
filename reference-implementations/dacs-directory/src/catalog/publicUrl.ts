let warned = false;

/**
 * The directory's public origin for canonical URLs, sitemap, robots, llms.txt
 * and Metadata. Request-bound routes should prefer requestBaseUrl below;
 * these static/metadata surfaces cannot, so they need explicit configuration.
 * Falling back to localhost is correct in dev but silently poisons canonical
 * URLs and the sitemap in production — hence the one-time warning.
 */
export const directoryBaseUrl = (): string => {
  const configured = process.env.NEXT_PUBLIC_DIRECTORY_URL;
  if (!configured && process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    console.warn(
      "NEXT_PUBLIC_DIRECTORY_URL is not set: canonical URLs, the sitemap, robots.txt " +
      "and llms.txt will advertise http://localhost:3400. Set it to the public origin.",
    );
  }
  return (configured ?? "http://localhost:3400").replace(/\/$/, "");
};

export const requestBaseUrl = (req: { headers: Headers; nextUrl: URL }): string => {
  if (process.env.NEXT_PUBLIC_DIRECTORY_URL) return directoryBaseUrl();
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}`.replace(/\/$/, "") : req.nextUrl.origin;
};
