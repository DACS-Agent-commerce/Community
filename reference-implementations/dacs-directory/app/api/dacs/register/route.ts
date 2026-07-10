/**
 * POST /api/dacs/register — submit a registration. The payload is a POINTER
 * set (primary claim + anchor addresses), not trusted content: everything is
 * verified from chain at index time. MVP: appends to the registration file;
 * the next reindex pass picks it up.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyOwnerSignature } from "@/src/catalog/registrationSig";
import { parseRegistration } from "@/src/catalog/registration";
import { rateLimit, rejectOversizeRequest } from "@/src/catalog/security";
import { loadRegistrations, saveRegistrations, withDataLock } from "@/src/catalog/store";

export async function POST(req: NextRequest) {
  const blocked = rateLimit(req, "register", 10, 10 * 60_000) ?? rejectOversizeRequest(req);
  if (blocked) return blocked;
  const parsed = parseRegistration(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.value;

  // Owner signature (optional): verified NOW so the submitter gets immediate
  // feedback; a bad signature rejects rather than silently downgrading.
  let ownerVerified = false;
  if (body.ownerSignature) {
    ownerVerified = await verifyOwnerSignature(body);
    if (!ownerVerified) {
      return NextResponse.json(
        { error: "ownerSignature present but invalid (wrong key, stale, or message mismatch)" },
        { status: 400 },
      );
    }
  }

  return withDataLock("registrations", () => {
    const regs = loadRegistrations();
    const idx = regs.findIndex((r) => r.primaryClaim === body.primaryClaim);
    const prior = idx >= 0 ? regs[idx] : undefined;
    // Once a claim has any registration, replacements must be owner-signed.
    // Third-party submissions may create candidates but cannot seize an entry.
    if (prior && !ownerVerified) {
      return NextResponse.json(
        { error: "this agent is already registered — updates must be signed by its key" },
        { status: 403 },
      );
    }
    if (idx >= 0) regs[idx] = body;
    else regs.push(body);
    saveRegistrations(regs);
    return NextResponse.json({
      ok: true,
      ownerVerified,
      queued: true,
      note: "indexed at next pass" + (ownerVerified ? " (owner-registered)" : " (third-party submission)"),
    });
  });
}
