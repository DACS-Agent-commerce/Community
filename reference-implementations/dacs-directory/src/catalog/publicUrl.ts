export const directoryBaseUrl = (): string =>
  (process.env.NEXT_PUBLIC_DIRECTORY_URL ?? "http://localhost:3400").replace(/\/$/, "");
