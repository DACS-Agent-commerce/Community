import type { Metadata } from "next";
import BusinessConsole from "@/src/components/BusinessConsole";
import { loadCatalog } from "@/src/catalog/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "My business — DACS Directory",
  description: "Manage listings, commercial activity, reputation, and agent access for a DACS provider.",
};

export default function BusinessPage() {
  const catalog = loadCatalog();
  return <BusinessConsole sellers={catalog.sellers} generatedAt={catalog.generatedAt} />;
}
