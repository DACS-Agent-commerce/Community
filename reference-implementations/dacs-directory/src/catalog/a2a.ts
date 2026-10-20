/**
 * The A2A agent-card fields the well-known generator emits. DACS-1 §6.3.5 adds the `dacs` block
 * to an existing A2A agent card, so a generated card is a complete A2A AgentCard.
 * Pinned to A2A protocol v0.3.0: github.com/a2aproject/A2A tag v0.3.0, commit
 * 8d57eba286de756176892518a8fc39b0ac2ccefb, specification/json/a2a.json (vendored byte-identical at
 * test/fixtures/a2a/a2a.json; its sha256 is recorded in SPEC_PIN).
 */
export const A2A_PROTOCOL_VERSION = "0.3.0";
/** a2a.json `TransportProtocol`. */
export const A2A_TRANSPORTS = ["JSONRPC", "GRPC", "HTTP+JSON"] as const;
export type A2aTransport = (typeof A2A_TRANSPORTS)[number];

/**
 * The publisher's declared A2A service: an absolute HTTPS URL without credentials, fragment,
 * whitespace or control characters, and one pinned transport. Returns null for anything else.
 * The card carries the parsed URL, so it holds exactly the address a client will request.
 */
export function a2aService(endpoint: string | null | undefined, transport: string | null | undefined): { url: string; transport: A2aTransport } | null {
  const raw = endpoint?.trim() ?? "";
  if (!raw || raw.length > 2048 || /[\s#\u0000-\u001f\u007f]/.test(raw)) return null;
  if (!A2A_TRANSPORTS.includes(transport as A2aTransport)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
  return { url: url.href, transport: transport as A2aTransport };
}
