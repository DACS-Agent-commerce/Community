import TryDacs from "@/src/components/TryDacs";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Try DACS",
  description: "Run a live fixed-price or RFQ agent procurement and inspect every DACS receipt from listing discovery through verified delivery.",
  alternates: { canonical: "/try" },
};

export default function TryPage() {
  return <TryDacs />;
}
