/**
 * POST /api/dacs/prepare-registration — issue a fresh, content-bound owner
 * signing message for an already finalized and authenticated listing pointer.
 *
 * The browser can safely resume registration after a reload or an expired
 * signature without rebuilding or rebroadcasting the on-chain listing.
 */
import { NextRequest, NextResponse } from "next/server";
import { parseRegistration } from "@/src/catalog/registration";
import { registrationMessage } from "@/src/catalog/registrationSig";
import { rateLimit, rejectOversizeRequest } from "@/src/catalog/security";

export async function POST(req: NextRequest) {
  const blocked = rateLimit(req, "prepare-registration", 20, 10 * 60_000) ?? rejectOversizeRequest(req);
  if (blocked) return blocked;
  const raw = await req.json().catch(() => null) as Record<string, unknown> | null;
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
