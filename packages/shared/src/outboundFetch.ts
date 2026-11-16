/** How long a call to another service may take, unless its caller sets another limit. */
export const OUTBOUND_FETCH_TIMEOUT_MS = 15_000;

/**
 * fetch with a time limit, for the calls a server makes to another service.
 * Node's fetch waits up to 300 seconds for the headers and 300 more between
 * chunks of the body, so a service that stalls would hold a request or a job
 * slot for minutes. The limit covers the whole exchange, reading the body
 * included, and ends it with a TimeoutError. A signal in `init` still aborts
 * the call too.
 */
export async function fetchWithTimeout(input: string | URL | Request, init: RequestInit = {}, timeoutMs: number = OUTBOUND_FETCH_TIMEOUT_MS): Promise<Response> {
  const limit = AbortSignal.timeout(timeoutMs);
  return await fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit });
}
