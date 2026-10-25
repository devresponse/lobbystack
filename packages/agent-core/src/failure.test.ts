import { APICallError, RetryError, StreamProviderError, TypeValidationError } from "ai";
import { describe, expect, it } from "vitest";

import { describeAgentFailure, EmptyReplyError } from "./failure";

const url = "https://api.openai.com/v1/responses";

// What the OpenAI provider throws for a refused request: the body's error in `data`.
function openAIError(statusCode: number, error: { message: string; type?: string; param?: string | null; code?: string | null }, isRetryable = false): APICallError {
  return new APICallError({ message: error.message, url, requestBodyValues: { input: "Are you open on Sunday?" }, statusCode, isRetryable, data: { error } });
}

describe("describeAgentFailure", () => {
  it("names what OpenAI refused: its status, code, type and the field", () => {
    const refusal = openAIError(400, { message: "Unsupported value: 'high' is not supported with this model.", type: "invalid_request_error", param: "reasoning.effort", code: "unsupported_value" });

    expect(describeAgentFailure(refusal)).toEqual({
      category: "provider_rejected",
      error: refusal,
      providerErrorStatus: 400,
      providerErrorCode: "unsupported_value",
      providerErrorKind: "invalid_request_error",
      providerErrorParam: "reasoning.effort",
      retryable: false,
    });
  });

  it.each([
    [401, "provider_auth"],
    [403, "provider_auth"],
    [404, "provider_rejected"],
    [413, "provider_rejected"],
    [429, "provider_rate_limited"],
    [408, "provider_unavailable"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
  ])("files HTTP %i as %s", (status, category) => {
    expect(describeAgentFailure(openAIError(status, { message: "Refused." })).category).toBe(category);
  });

  it("reports the last attempt of a retried request, and counts the attempts", () => {
    const attempts = [1, 2, 3].map(() => openAIError(429, { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" }, true));
    const retried = new RetryError({ message: "Failed after 3 attempts. Last error: You exceeded your current quota.", reason: "maxRetriesExceeded", errors: attempts });

    expect(describeAgentFailure(retried)).toMatchObject({ category: "provider_rate_limited", error: attempts[2], providerErrorStatus: 429, providerErrorCode: "insufficient_quota", retryable: true, attempts: 3 });
  });

  it("reads an error the stream sent after OpenAI accepted the request", () => {
    const failed = new StreamProviderError({
      message: "The server had an error while processing your request.",
      type: "response.failed",
      code: "server_error",
      statusCode: 500,
      data: { type: "response.failed", response: { error: { code: "server_error", message: "The server had an error while processing your request." } } },
    });

    expect(describeAgentFailure(failed)).toMatchObject({ category: "provider_unavailable", error: failed, providerErrorStatus: 500, providerErrorCode: "server_error", providerErrorKind: "response.failed", retryable: true });
  });

  it("files a request that got no answer as unreachable", () => {
    const unreachable = new APICallError({ message: "Cannot connect to API: getaddrinfo ENOTFOUND api.openai.com", url, requestBodyValues: {}, isRetryable: true });

    expect(describeAgentFailure(unreachable)).toEqual({ category: "provider_unreachable", error: unreachable, retryable: true });
  });

  it("files an answer that couldn't be read", () => {
    expect(describeAgentFailure(new TypeValidationError({ value: { type: "response.unknown" }, cause: new Error("Invalid input") })).category).toBe("invalid_response");
  });

  it.each([
    ["length", "output_limit"],
    ["content-filter", "content_filter"],
    ["tool-calls", "step_limit"],
    ["stop", "no_reply"],
    [undefined, "no_reply"],
  ])("files an empty reply that finished with %s as %s", (finishReason, category) => {
    const empty = new EmptyReplyError(finishReason);

    expect(describeAgentFailure(empty)).toEqual({ category, error: empty, ...(finishReason ? { finishReason } : {}) });
    expect(empty.message).toBe(`The AI assistant returned an empty reply (finish reason: ${finishReason ?? "unknown"}).`);
  });

  it("makes an Error to report from anything else that was thrown", () => {
    const fromEvent = describeAgentFailure({ type: "error", code: "rate_limit_exceeded", message: "Rate limit reached for requests.", param: null });
    expect(fromEvent).toMatchObject({ category: "generation_failed", providerErrorCode: "rate_limit_exceeded" });
    expect(fromEvent).not.toHaveProperty("providerErrorKind");
    expect(fromEvent.error).toBeInstanceOf(Error);
    expect(fromEvent.error.message).toBe("Rate limit reached for requests.");

    expect(describeAgentFailure("socket hang up").error.message).toBe("socket hang up");
    expect(describeAgentFailure(undefined).error.message).toBe("The AI provider failed without a message.");
    const bug = new TypeError("Cannot read properties of undefined (reading 'toolName')");
    expect(describeAgentFailure(bug)).toEqual({ category: "generation_failed", error: bug });
  });
});
