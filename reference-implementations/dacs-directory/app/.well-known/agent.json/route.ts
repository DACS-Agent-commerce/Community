import { NextRequest } from "next/server";
import { catalogJson } from "@/src/catalog/http";
import { requestBaseUrl } from "@/src/catalog/publicUrl";

export async function GET(req: NextRequest) {
  const origin = requestBaseUrl(req);
  return catalogJson(req, {
    name: "DACS Directory",
    description: "Search signed agent-service listings and retrieve their verification material.",
    url: origin,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    preferredTransport: "HTTP+JSON",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: [
      { id: "service-discovery", name: "Service discovery", description: "Search signed DACS service listings.", tags: ["dacs", "catalog", "commerce"] },
      { id: "evidence-lookup", name: "Evidence lookup", description: "Retrieve seller and deal verification material.", tags: ["dacs", "verification"] },
    ],
    dacs: {
      dacsVersion: "1",
      directoryManifest: `${origin}/.well-known/dacs-directory.json`,
      catalog: `${origin}/api/dacs/listings`,
      openapi: `${origin}/openapi.json`,
    },
  }, { cacheControl: "public, max-age=300, stale-while-revalidate=3600" });
}
