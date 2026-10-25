import { APICallError, RetryError } from "ai";

/** Why an agent's reply failed, as a stable label for logs, dashboards and alerts. */
export type AgentFailureCategory =
  /** HTTP 401 or 403: the API key, or its project's access to the model. */
  | "provider_auth"
  /** HTTP 400, 404, 413 or 422: the provider refused the request, such as an unknown model, a setting the model doesn't take, or too long a prompt. */
  | "provider_rejected"
  /** HTTP 429: a rate limit, or a used-up quota or credit. */
  | "provider_rate_limited"
  /** HTTP 408, 409 or 5xx: the provider failed or was overloaded. */
  | "provider_unavailable"
  /** No answer came back, such as when the provider's address can't be reached. */
  | "provider_unreachable"
  /** The provider's answer couldn't be read. */
  | "invalid_response"
  /** The model reached the output cap before writing any text. */
  | "output_limit"
  | "content_filter"
  /** The agent spent all its steps on tools without writing a reply. */
  | "step_limit"
  /** The model finished without writing anything. */
  | "no_reply"
  | "generation_failed";

/**
 * A reply that ended without text although the model reported no error. How
 * its last step finished says why.
 */
export class EmptyReplyError extends Error {
  readonly finishReason: string | undefined;
  readonly category: AgentFailureCategory;

  constructor(finishReason: string | undefined) {
    super(`The AI assistant returned an empty reply (finish reason: ${finishReason ?? "unknown"}).`);
    this.name = "EmptyReplyError";
    this.finishReason = finishReason;
    this.category = finishReason === "length" ? "output_limit" : finishReason === "content-filter" ? "content_filter" : finishReason === "tool-calls" ? "step_limit" : "no_reply";
  }
}

/**
 * Why a reply failed, in fields that are safe to log and report: the
 * provider's HTTP status and its own error code, type and parameter, never
 * the request or the reply.
 */
export type AgentFailure = {
  category: AgentFailureCategory;
  /**
   * The error to report, whose message is the provider's explanation: the
   * last attempt's when the SDK retried, or one made from a provider's error
   * object, which isn't an Error.
   */
  error: Error;
  providerErrorStatus?: number;
  /** Such as `model_not_found`, `invalid_api_key` or `insufficient_quota`. */
  providerErrorCode?: string;
  /** OpenAI's error type, such as `invalid_request_error`. */
  providerErrorKind?: string;
  /** The request field the provider refused, such as `reasoning.effort`. */
  providerErrorParam?: string;
  retryable?: boolean;
  /** How many requests were made, when the SDK retried. */
  attempts?: number;
  finishReason?: string;
};

const INVALID_RESPONSE_ERRORS = new Set(["AI_TypeValidationError", "AI_JSONParseError", "AI_InvalidResponseDataError", "AI_EmptyResponseBodyError"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : typeof value === "number" ? String(value) : undefined;
}

function categoryOf(error: unknown, status: number | undefined): AgentFailureCategory {
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 429) return "provider_rate_limited";
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) return "provider_unavailable";
  if (status !== undefined && status >= 400) return "provider_rejected";
  if (APICallError.isInstance(error)) return "provider_unreachable";
  if (error instanceof Error && INVALID_RESPONSE_ERRORS.has(error.name)) return "invalid_response";
  return "generation_failed";
}

/**
 * Reads what the AI SDK threw or streamed: an APICallError for a refused
 * request, a StreamProviderError for one that failed mid-stream, a RetryError
 * around the attempts it retried, or anything else.
 */
export function describeAgentFailure(error: unknown): AgentFailure {
  if (error instanceof EmptyReplyError) return { category: error.category, error, ...(error.finishReason ? { finishReason: error.finishReason } : {}) };
  const retried = RetryError.isInstance(error) ? error : undefined;
  const last: unknown = retried?.lastError ?? error;
  const value = record(last);
  // OpenAI's error body is { error: { message, type, param, code } }. A stream
  // error keeps the event it came in, where the details may sit at the top.
  const data = record(value?.data);
  const body = record(data?.error) ?? record(record(data?.response)?.error) ?? data;
  const status = typeof value?.statusCode === "number" ? value.statusCode : undefined;
  const code = label(body?.code) ?? label(value?.code);
  const kind = label(body?.type) ?? label(value?.type);
  const param = label(body?.param);
  const message = typeof value?.message === "string" ? value.message : typeof last === "string" ? last : "The AI provider failed without a message.";
  return {
    category: categoryOf(last, status),
    error: last instanceof Error ? last : new Error(message),
    ...(status !== undefined ? { providerErrorStatus: status } : {}),
    ...(code ? { providerErrorCode: code } : {}),
    // A stream event's own type, "error", says nothing.
    ...(kind && kind !== "error" ? { providerErrorKind: kind } : {}),
    ...(param ? { providerErrorParam: param } : {}),
    ...(typeof value?.isRetryable === "boolean" ? { retryable: value.isRetryable } : {}),
    ...(retried ? { attempts: retried.errors.length } : {}),
  };
}
