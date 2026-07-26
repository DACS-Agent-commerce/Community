import { NextResponse } from "next/server";

import { buildCounterpartyEvidenceRun } from "@/src/catalog/counterpartyEvidence";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(buildCounterpartyEvidenceRun());
}

export async function GET() {
  return NextResponse.json({
    serviceId: "counterparty-evidence-receipt",
    method: "POST",
    mode: "fixture",
    description: "Run the fixture-backed Counterparty Evidence Desk service without live spend.",
  });
}
