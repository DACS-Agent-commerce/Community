/**
 * POST /api/dacs/prepare-registration — parse an unsigned pointer set and
 * return a fresh content-bound message for the owner's client to sign.
 * This endpoint never signs or confirms publication. The owner submits the
 * signed result to /api/dacs/register; indexing verifies the chain artifacts.
 */
import { NextRequest, NextResponse } from "next/server";
import { parseRegistration } from "@/src/catalog/registration";
import { registrationMessage } from "@/src/catalog/registrationSig";
import { rateLimit, readRequestJson } from "@/src/catalog/security";

export async function POST(req: NextRequest) {
  const blocked = rateLimit(req, "prepare-registration", 20, 10 * 60_000);
  if (blocked) return blocked;
  const input = await readRequestJson(req);
  if (!input.ok) return input.response;
  const raw = input.value as Record<string, unknown> | null;
  if (raw?.ownerSignature !== undefined) {
    return NextResponse.json({ error: "prepare-registration expects an unsigned registration" }, { status: 400 });
  }
  const parsed = parseRegistration(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const registration = parsed.value;
  const signedAt = Date.now();
  return NextResponse.json({
    registration: {
      ...registration,
      ownerSignature: {
        message: registrationMessage(registration, signedAt),
        signedAt,
      },
    },
  });
}
