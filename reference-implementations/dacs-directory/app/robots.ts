import type { MetadataRoute } from "next";
import { directoryBaseUrl } from "@/src/catalog/publicUrl";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${directoryBaseUrl()}/sitemap.xml` };
}
