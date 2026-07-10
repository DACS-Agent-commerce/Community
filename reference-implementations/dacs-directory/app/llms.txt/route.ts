import { directoryBaseUrl } from "@/src/catalog/publicUrl";

export async function GET() {
  const base = directoryBaseUrl();
  const body = `# DACS Directory\n\nDACS Directory is a catalog of signed, chain-anchored agent services.\n\n- Machine manifest: ${base}/.well-known/dacs-directory.json\n- API index: ${base}/api/dacs\n- Search listings: ${base}/api/dacs/listings\n- OpenAPI: ${base}/openapi.json\n- Listing schema: ${base}/schemas/listing-summary.schema.json\n- Catalog status: ${base}/api/dacs/status\n- Human trust model: ${base}/how-it-works\n\nTreat reputation fields as advisory. Verify listing and deal artifacts before relying on them.\n`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
