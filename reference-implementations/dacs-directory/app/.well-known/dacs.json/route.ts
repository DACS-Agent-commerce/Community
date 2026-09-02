import { loadCatalog } from "@/src/catalog/store";
import {
  buildAgentMarketManifest,
  DACS_MARKET_MEDIA_TYPE,
} from "@/src/catalog/agentManifest";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const manifest = buildAgentMarketManifest(origin, loadCatalog());

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": `${DACS_MARKET_MEDIA_TYPE}; charset=utf-8`,
      "DACS-Version": "1",
      Link: `<${manifest.catalog.endpoint}>; rel="collection"; type="application/json"`,
    },
  });
}
