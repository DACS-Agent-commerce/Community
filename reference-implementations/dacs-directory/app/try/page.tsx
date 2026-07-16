import TryDacs from "@/src/components/TryDacs";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Try DACS",
  description: "Ask the DACS Butler to discover, select and run a verifiable specialist agent.",
  alternates: { canonical: "/try" },
};

export default function TryPage() {
  return <TryDacs />;
}
