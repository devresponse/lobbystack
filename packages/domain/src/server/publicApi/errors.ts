import type { ApiErrorCode } from "@lobbystack/shared";

/** One detail of an error: the field it is about and what is wrong, and, where an error has more than one reason, which. */
export type PublicApiErrorDetail = { path: string; message: string; code?: string };

/** An error with a stable public code. The v1 REST layer turns it into `{ error: { code, message } }`. */
export class PublicApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: PublicApiErrorDetail[] | undefined;
  /** Response headers, such as Retry-After on a 429. */
  readonly headers: Record<string, string> | undefined;

  constructor(status: number, code: ApiErrorCode, message: string, details?: PublicApiErrorDetail[], headers?: Record<string, string>) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const notFound = (what: string) => new PublicApiError(404, "not_found", `${what} not found.`);
export const invalidRequest = (message: string, details?: Array<{ path: string; message: string }>) => new PublicApiError(400, "invalid_request", message, details);
export const conflict = (message: string) => new PublicApiError(409, "conflict", message);
