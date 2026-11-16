import { NextResponse } from "next/server";
import { z } from "zod";

import { readUserInterfaceLocale, setUserInterfaceLocale } from "@lobbystack/domain";
import { asApiResponse, requireApiSession } from "@/lib/api-helpers";
import { parseBody } from "@/lib/request-input";
import { getAuthDatabase } from "@/lib/auth";
import { SUPPORTED_LOCALES } from "@/lib/locale";

export const dynamic = "force-dynamic";

const localeChoice = z.object({ locale: z.enum(SUPPORTED_LOCALES, `locale must be one of ${SUPPORTED_LOCALES.join(", ")}.`) });

export async function GET(request: Request) {
  try {
    const session = await requireApiSession(request);
    return NextResponse.json({ locale: await readUserInterfaceLocale(getAuthDatabase().db, { userId: session.user.id }) ?? "en" });
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireApiSession(request);
    const { locale } = await parseBody(request, localeChoice);
    await setUserInterfaceLocale(getAuthDatabase().db, { userId: session.user.id, locale });
    return NextResponse.json({ locale });
  } catch (error) {
    return asApiResponse(error);
  }
}
