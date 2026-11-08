// What LobbyStack sells in Polar: the organization's settings, meters,
// products, discounts and webhook endpoints, read whole for a plan or a
// check, and the single calls that change them. Polar has no
// transactions and reads no idempotency key, so only reads are retried: a
// write that timed out may have landed, and the caller finds it again by its
// metadata tags instead of repeating it.

import { POLAR_API_VERSION, trimTrailingSlashes } from "@lobbystack/shared";
import type { BillingCatalogClient } from "../billing/types";

export type PolarMetadata = Record<string, string | number | boolean>;

export type PolarOrganization = {
  id: string;
  name: string;
  default_presentment_currency?: string | null;
  subscription_settings?: Record<string, unknown> | null;
  customer_portal_settings?: Record<string, unknown> | null;
};

export type PolarMeter = { id: string; name: string; filter: unknown; aggregation: unknown; metadata: PolarMetadata; archived_at: string | null };

export type PolarPrice = {
  id: string;
  amount_type: string;
  is_archived: boolean;
  price_currency: string;
  source?: string;
  price_amount?: number;
  unit_amount?: string | number;
  meter_id?: string;
};

export type PolarProduct = {
  id: string;
  name: string;
  recurring_interval: string | null;
  recurring_interval_count?: number | null;
  /** The meter cycle its overage is invoiced on, such as month on an annual product; null when that follows the billing cycle. Polar never changes it. */
  meter_interval?: string | null;
  meter_interval_count?: number | null;
  visibility?: string;
  is_archived: boolean;
  metadata: PolarMetadata;
  prices: PolarPrice[];
  /** Its benefits, of every kind: a run takes Credits (meter_credit) off LobbyStack's products. */
  benefits: Array<{ id: string; type: string; description?: string }>;
  created_at?: string;
  modified_at?: string | null;
};

export type PolarDiscount = {
  id: string;
  name: string;
  type: "percentage" | "fixed";
  basis_points?: number;
  amounts?: Record<string, number>;
  duration: "once" | "forever" | "repeating";
  duration_in_months?: number | null;
  code: string | null;
  ends_at: string | null;
  redemptions_count: number;
  products: Array<{ id: string }>;
  metadata: PolarMetadata;
};

/** api_version is the version of the payloads Polar sends it. */
export type PolarWebhookEndpoint = { id: string; url: string; format: string; events: string[]; enabled: boolean; api_version?: string; secret?: string };

/** Everything in one organization that LobbyStack reads, archived objects included. */
export type PolarSnapshot = {
  organization: PolarOrganization;
  meters: PolarMeter[];
  products: PolarProduct[];
  discounts: PolarDiscount[];
  webhooks: PolarWebhookEndpoint[];
};

export class PolarApiError extends Error {
  constructor(readonly method: string, readonly path: string, readonly status: number, detail: string) {
    super(`Polar answered ${status} to ${method} ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`);
    this.name = "PolarApiError";
  }
}

export type PolarCatalogConfig = {
  token: string;
  baseUrl: string;
  fetch?: typeof fetch;
  sleep?(milliseconds: number): Promise<void>;
  timeoutMs?: number;
};

const READ_ATTEMPTS = 4;

function describeBody(body: unknown): string {
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  if (Array.isArray(detail)) return detail.map((item: { loc?: unknown[]; msg?: string }) => `${(item.loc ?? []).join(".")}: ${item.msg ?? ""}`).join("; ");
  if (typeof detail === "string") return detail;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/** An object made earlier in the same run, named until Polar gives it an id. */
export type PolarRef = { $ref: string };

/** One Polar call of a catalog plan, as the runner needs it: the domain's PolarStep adds what people read. */
export type PolarCatalogStep = {
  object: string;
  action: string;
  method: "POST" | "PATCH";
  /** A {{ref}} in it is an object made earlier in the run. */
  path: string;
  body: unknown;
  /** The ref the created object's id answers to. */
  produces?: string;
};

export type PolarCaller = { request(method: "POST" | "PATCH", path: string, body: unknown): Promise<unknown> };

export const polarRef = (name: string): PolarRef => ({ $ref: name });
export const isPolarRef = (value: unknown): value is PolarRef => Boolean(value && typeof value === "object" && "$ref" in value);

function resolveRefs(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (isPolarRef(value)) {
    const id = ids.get(value.$ref);
    if (!id) throw new Error(`No Polar id for ${value.$ref}: the call that makes it didn't run.`);
    return id;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry, ids)]));
  return value;
}

/**
 * Makes each call in order, putting the ids of objects made earlier into the
 * ones after. Stops at the first failure: what landed is found again by its
 * tags on the next run. Returns the new webhook's secret, when one was made;
 * onStep hears it with the call that made the webhook, so a caller keeps it
 * even when a later call fails.
 */
export async function runPolarSteps<Step extends PolarCatalogStep>(caller: PolarCaller, steps: readonly Step[], onStep?: (step: Step, webhookSecret: string | null) => void): Promise<{ webhookSecret: string | null }> {
  const ids = new Map<string, string>();
  let webhookSecret: string | null = null;
  for (const step of steps) {
    const path = step.path.replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => resolveRefs(polarRef(name), ids) as string);
    const result = (await caller.request(step.method, path, resolveRefs(step.body, ids))) as { id?: unknown; secret?: unknown } | null;
    if (step.produces) {
      if (typeof result?.id !== "string") throw new Error(`Polar made ${(step as { subject?: string }).subject ?? step.object} but sent no id back. Run again: it is found by its tags.`);
      ids.set(step.produces, result.id);
    }
    const secret = step.object === "webhook" && step.action === "create" && typeof result?.secret === "string" ? result.secret : null;
    if (secret) webhookSecret = secret;
    onStep?.(step, secret);
  }
  return { webhookSecret };
}

/** Reads a Polar organization's catalog objects and runs a catalog plan's calls (ADR 0010). */
export class PolarCatalogClient implements BillingCatalogClient<PolarSnapshot, PolarCatalogStep> {
  readonly provider = "polar" as const;
  private readonly send: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly config: PolarCatalogConfig) {
    this.send = config.fetch ?? fetch;
    this.sleep = config.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** One call. Reads are retried after a network error, a 5xx or a 429; a write only after a 429, which Polar answers before doing anything. */
  async request<T = unknown>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.send(`${trimTrailingSlashes(this.config.baseUrl)}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.config.token}`, accept: "application/json", "polar-version": POLAR_API_VERSION, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
        });
      } catch (error) {
        if (method === "GET" && attempt < READ_ATTEMPTS) {
          await this.sleep(1_000 * attempt);
          continue;
        }
        const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
        throw new Error(`Couldn't reach ${this.config.baseUrl} for ${method} ${path.split("?")[0]} (${cause}).${method === "GET" ? "" : " The change may have landed: run again, and it is found by its tags."}`);
      }
      if ((response.status === 429 || (method === "GET" && response.status >= 500)) && attempt < READ_ATTEMPTS) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.sleep(retryAfter > 0 ? retryAfter * 1_000 : 1_000 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!response.ok) throw new PolarApiError(method, path, response.status, describeBody(data));
      return data as T;
    }
  }

  /** Every item of a list, 100 a page. */
  async listAll<T>(path: string, filters: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ ...filters, page: String(page), limit: "100" });
      const data = await this.request<{ items?: T[]; pagination?: { max_page?: number } }>("GET", `${path}?${query}`);
      items.push(...(data?.items ?? []));
      if (page >= (data?.pagination?.max_page ?? 1)) return items;
    }
  }

  /** Runs a catalog plan's calls in order; see runPolarSteps. */
  async run<Step extends PolarCatalogStep>(steps: readonly Step[], onStep?: (step: Step, webhookSecret: string | null) => void): Promise<{ webhookSecret: string | null }> {
    return await runPolarSteps(this, steps, onStep);
  }

  /**
   * The organization the token belongs to, and every object LobbyStack reads
   * in it. The token must reach exactly one organization. With webhooks false
   * it leaves the webhook endpoints out, as an empty list: Polar lists each
   * one with its signing secret, so a token that never needs the secret goes
   * without webhooks:read.
   */
  async readSnapshot(options: { webhooks?: boolean } = {}): Promise<PolarSnapshot> {
    const organizations = await this.listAll<PolarOrganization>("/v1/organizations/");
    if (organizations.length !== 1) throw new Error(`The Polar token reaches ${organizations.length} organizations. Use an organization access token, which reaches exactly one.`);
    // One list at a time: a sandbox organization is small, and Polar limits the rate per token.
    const meters = await this.listAll<PolarMeter>("/v1/meters/");
    const products = await this.listAll<PolarProduct>("/v1/products/");
    const discounts = await this.listAll<PolarDiscount>("/v1/discounts/");
    const webhooks = options.webhooks === false ? [] : await this.listAll<PolarWebhookEndpoint>("/v1/webhooks/endpoints");
    return { organization: organizations[0]!, meters, products, discounts, webhooks };
  }
}
