export async function GET() {
  return new Response(null, {
    status: 308,
    headers: {
      location: "/schemas/listing-summary.v2.schema.json",
      "cache-control": "public, max-age=300, must-revalidate",
    },
  });
}
