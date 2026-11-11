import type { BusinessLimit } from "@/hooks/use-active-business";

/**
 * The signed-in account's business allowance, as GET /api/businesses gives
 * it, or null when it can't be read. A page the server refused with
 * business_limit reads it to say whether a higher plan on one of the
 * account's businesses would let it own more.
 */
export async function readBusinessLimit(): Promise<BusinessLimit | null> {
  try {
    const response = await fetch("/api/businesses", { credentials: "include" });
    if (!response.ok) return null;
    return ((await response.json()) as { businessLimit?: BusinessLimit }).businessLimit ?? null;
  } catch {
    return null;
  }
}
