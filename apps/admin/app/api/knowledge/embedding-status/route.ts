import { NextResponse } from "next/server";

import { readKnowledgeEmbeddingStatusInTransaction } from "@lobbystack/domain";
import { createEmbeddingProvider } from "@lobbystack/providers";

import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) =>
      await readKnowledgeEmbeddingStatusInTransaction(tx, { businessId, fingerprint: createEmbeddingProvider()?.fingerprint ?? null })));
  } catch (error) {
    return asApiResponse(error);
  }
}
