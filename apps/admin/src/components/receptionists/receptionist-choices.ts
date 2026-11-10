"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { isUuid, type ReceptionistKnowledgeScope, type ReceptionistStatus } from "@lobbystack/shared";

import { requestJson } from "@/lib/request-json";

// The receptionists every dropdown, multiselect and filter in the dashboard
// lists, and the ?receptionist=<id> filter the record pages keep in their
// address.

/** A receptionist that isn't archived, as GET /api/receptionists/choices gives it. */
export type ReceptionistOption = {
  id: string;
  name: string;
  /** "What it helps with", shown under its name. */
  description: string;
  handle: string | null;
  isDefault: boolean;
  status: ReceptionistStatus;
  listed: boolean;
  sortOrder: number;
  /** Its own language; null speaks the business's. */
  locale: string | null;
  knowledgeScope: ReceptionistKnowledgeScope;
};

/** Every receptionist query of a business, for invalidating after a change. */
export const receptionistsQueryKey = (businessId: string | undefined) => ["receptionists", businessId] as const;

export const receptionistChoicesQueryKey = (businessId: string | undefined) => [...receptionistsQueryKey(businessId), "choices"] as const;

/** The business's receptionists that aren't archived: the default first, then the Receptionists page's order. */
export function useReceptionistChoices(businessId: string | undefined) {
  const query = useQuery({
    queryKey: receptionistChoicesQueryKey(businessId),
    queryFn: () => requestJson<{ receptionists: ReceptionistOption[] }>(`/api/receptionists/choices?businessId=${encodeURIComponent(businessId!)}`),
    enabled: Boolean(businessId),
    staleTime: 60_000,
  });
  return { ...query, receptionists: query.data?.receptionists ?? [] };
}

/** Lower case without accents, so a search for "recepcion" finds "Recepción". */
export function foldForSearch(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
}

/** Whether a receptionist's name or "What it helps with" contains the search. */
export function receptionistMatches(receptionist: Pick<ReceptionistOption, "name" | "description">, search: string): boolean {
  const term = foldForSearch(search.trim());
  return !term || foldForSearch(`${receptionist.name} ${receptionist.description}`).includes(term);
}

export const RECEPTIONIST_FILTER_PARAM = "receptionist";

/**
 * The receptionist a record page is filtered to, kept in its address
 * (?receptionist=<id>) so the filter survives a reload and a shared link, and
 * a setter that changes it and goes back to the first page.
 */
export function useReceptionistFilter(): [string | null, (receptionistId: string | null) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get(RECEPTIONIST_FILTER_PARAM)?.trim();
  const receptionistId = raw && isUuid(raw) ? raw.toLowerCase() : null;
  const setReceptionistId = useCallback((next: string | null) => {
    const query = new URLSearchParams(params.toString());
    if (next) query.set(RECEPTIONIST_FILTER_PARAM, next);
    else query.delete(RECEPTIONIST_FILTER_PARAM);
    query.delete("page");
    const search = query.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  }, [params, pathname, router]);
  return [receptionistId, setReceptionistId];
}

/** The ?receptionist= part of an API address for a filter, or nothing. */
export function receptionistQuery(receptionistId: string | null | undefined): string {
  return receptionistId ? `&${RECEPTIONIST_FILTER_PARAM}=${encodeURIComponent(receptionistId)}` : "";
}
