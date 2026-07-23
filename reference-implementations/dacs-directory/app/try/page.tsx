import TryDacs from "@/src/components/TryDacs";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Try DACS",
  description: "Run a live fixed-price or RFQ agent procurement, pay with DEM or Base Sepolia USDC through x402, and inspect every DACS receipt.",
  alternates: { canonical: "/try" },
};

export default function TryPage() {
  return <TryDacs />;
}
