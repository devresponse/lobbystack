type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The GPT-Live models calls can run on. `LIVE_MODEL` picks one for a
 * deployment's phone and browser calls. The admin and the worker must agree,
 * since the recordings of call openings are kept per model.
 */
export const LIVE_MODELS = ["gpt-live-1.1", "gpt-live-1"] as const;

export type LiveModel = (typeof LIVE_MODELS)[number];

/** What calls run on when LIVE_MODEL is unset. */
export const DEFAULT_LIVE_MODEL: LiveModel = "gpt-live-1.1";

/**
 * What a call starts on instead when OpenAI refuses the configured model in a
 * way this one may not share, such as a project that doesn't allow the newer
 * model, or its concurrent-session limit being full: each model has its own.
 */
export const LIVE_FALLBACK_MODEL: LiveModel = "gpt-live-1";

export function isLiveModel(value: unknown): value is LiveModel {
  return typeof value === "string" && (LIVE_MODELS as readonly string[]).includes(value);
}

/** The model LIVE_MODEL names, or the default when it's unset. Throws on any other name. */
export function liveModelSetting(source: Environment): LiveModel {
  const value = source.LIVE_MODEL?.trim();
  if (!value) return DEFAULT_LIVE_MODEL;
  if (isLiveModel(value)) return value;
  throw new Error(`LIVE_MODEL must be ${LIVE_MODELS.join(" or ")}, or unset for ${DEFAULT_LIVE_MODEL}.`);
}

/** What's wrong with LIVE_MODEL, if anything, so a service can refuse to start and say so. */
export function liveModelSettingErrors(source: Environment): string[] {
  try {
    liveModelSetting(source);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

// OpenAI's refusals that hold for every model: no credit, a spend or usage
// limit, a country it doesn't serve, or another decision on the call first.
const REFUSED_FOR_EVERY_MODEL = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "unsupported_country_region_territory",
  "decision_already_made",
]);
// Refusals another model may not share: a request it can't take, a project
// without access to the model, an unknown model, a full concurrent-session
// limit (each model has its own) and an overloaded model. A server error is
// left out, since the session may exist anyway.
const REFUSAL_STATUSES = new Set([400, 403, 404, 429, 503]);

/** OpenAI's status, and its code when it gives one, on a refused session. */
export type LiveRefusal = { status: number; code?: string };

/**
 * The status and code of an error from OpenAI's SDK that refuses a session in
 * a way another model may not share, or nothing for any other error.
 */
export function liveModelRefusal(error: unknown): LiveRefusal | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, code, type } = error as { status?: unknown; code?: unknown; type?: unknown };
  if (typeof status !== "number" || !REFUSAL_STATUSES.has(status)) return undefined;
  if (typeof code === "string" && REFUSED_FOR_EVERY_MODEL.has(code)) return undefined;
  if (typeof type === "string" && REFUSED_FOR_EVERY_MODEL.has(type)) return undefined;
  return { status, ...(typeof code === "string" && code ? { code } : {}) };
}

/**
 * Starts a session with `config`, and once more on the fallback model when
 * OpenAI refuses the configured one in a way the fallback may not share.
 * Answers the config the session started with. `onFallback` hears about the
 * refusal before the second try. A config already on the fallback model, or
 * any other error, fails as it is.
 */
export async function withLiveModelFallback<Config extends { model: string }, Result>(
  config: Config,
  start: (config: Config) => Promise<Result>,
  onFallback?: (fallback: LiveRefusal & { model: string; fallbackModel: LiveModel }) => void,
): Promise<{ config: Config; result: Result }> {
  try {
    return { config, result: await start(config) };
  } catch (error) {
    const refusal = liveModelRefusal(error);
    if (!refusal || config.model === LIVE_FALLBACK_MODEL) throw error;
    onFallback?.({ ...refusal, model: config.model, fallbackModel: LIVE_FALLBACK_MODEL });
    const fallback: Config = { ...config, model: LIVE_FALLBACK_MODEL };
    return { config: fallback, result: await start(fallback) };
  }
}
