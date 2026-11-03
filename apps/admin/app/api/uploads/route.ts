import { NextResponse } from "next/server";

import { createObjectDownload, createUpload, finalizeUpload, readKnowledgeAudienceChoice } from "@lobbystack/domain";
import { uploadCreateRequestSchema, uploadDownloadRequestSchema, uploadFinalizeRequestSchema } from "@lobbystack/contracts";
import { asApiResponse, readJson, requireApiSession } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { getStorageProvider } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireApiSession(request);
    const url = new URL(request.url);
    const input = uploadDownloadRequestSchema.parse({
      businessId: url.searchParams.get("businessId"),
      objectId: url.searchParams.get("objectId"),
      ...(url.searchParams.get("range") ? { range: url.searchParams.get("range") } : {}),
    });
    return NextResponse.json(await createObjectDownload(createDomainContext(), {
      ...input,
      userId: session.user.id,
    }, getStorageProvider()));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = uploadCreateRequestSchema.parse(await readJson(request));
    return NextResponse.json(await createUpload(createDomainContext(), { ...body, userId: session.user.id, ...(body.checksum !== undefined ? { checksum: body.checksum } : {}) }, getStorageProvider()), { status: 201 });
  } catch (error) { return asApiResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const session = await requireApiSession(request);
    const raw = await readJson(request);
    const body = uploadFinalizeRequestSchema.parse(raw);
    // A knowledge file can be for chosen receptionists: audience and receptionistIds, set as the file is added.
    const audience = typeof raw === "object" && raw !== null && "audience" in raw && raw.audience !== undefined ? readKnowledgeAudienceChoice(raw) : undefined;
    await finalizeUpload(createDomainContext(), { ...body, userId: session.user.id, ...(body.checksum !== undefined ? { checksum: body.checksum } : {}), ...(audience ? { audience } : {}) }, getStorageProvider());
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
