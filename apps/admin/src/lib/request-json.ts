export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string; code?: string; errorId?: string } | null;
    // A server failure comes with the errorId it was logged under, so the page can show it.
    throw Object.assign(new Error(payload?.error ?? "Request failed."), payload?.code ? { code: payload.code } : {}, payload?.errorId ? { errorId: payload.errorId } : {});
  }

  return await response.json() as T;
}
