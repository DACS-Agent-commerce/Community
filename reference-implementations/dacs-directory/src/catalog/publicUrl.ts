export const directoryBaseUrl = (): string =>
  (process.env.NEXT_PUBLIC_DIRECTORY_URL ?? "http://localhost:3400").replace(/\/$/, "");

export const requestBaseUrl = (req: { headers: Headers; nextUrl: URL }): string => {
  if (process.env.NEXT_PUBLIC_DIRECTORY_URL) return directoryBaseUrl();
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}`.replace(/\/$/, "") : req.nextUrl.origin;
};
