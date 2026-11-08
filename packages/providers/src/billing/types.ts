import type { BillingInterval, PlanChangeRefusal } from "@lobbystack/shared";

// The billing provider seam (ADR 0010): what the worker, the admin and the
// scripts ask of a deployment's billing provider, with no provider's SDK type
// in it. Amounts are integer cents except where a money meter needs fractions.

export type BillingProviderId = "polar" | "stripe";
export type BillingEnv = "sandbox" | "live";

/** What overage bills: a call's minutes, alert texts and call transfers. */
export type OverageKind = "voice" | "alert_sms" | "transfer";

/** What sells one plan at one interval (a Polar product, a Stripe price), with the discount it sells with. */
export type PriceRef = { ref: string; discountRef: string | null };

/** The business's customer: the provider's ID once known, and the billing key the business is known by. */
export type CustomerRef = { id: string | null; billingKey: string };

/** A subscription as the provider shows it when read. */
export type ProviderSubscription = {
  id: string;
  /** Null when the provider's answer doesn't name it, as Polar's subscription reads don't. */
  customerId: string | null;
  state: "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "paused" | "canceled" | "ended";
  /** The plan item's product or price. */
  priceRef: string | null;
  interval: BillingInterval | null;
  discountRef: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** It ends then unless resumed. */
  cancelAt: Date | null;
  endedAt: Date | null;
  /** A change waiting for the renewal. */
  next: { priceRef: string; at: Date } | null;
  /** An upgrade waiting for payment, with the page that pays it. */
  pendingPayment: { url: string | null; expiresAt: Date } | null;
  metadata: Record<string, string>;
  /** When this was read: reconcile orders read-backs by it. */
  readAt: Date;
};

export type PlanChangeResult =
  | { status: "changed"; subscription: ProviderSubscription }
  /** Takes effect at the renewal. */
  | { status: "scheduled"; subscription: ProviderSubscription }
  /** The payment needs the customer, as for 3-D Secure, on this page. */
  | { status: "needs_action"; url: string; subscription: ProviderSubscription };

/** How a plan change charges: on an invoice now, on the next invoice, not at all, or with a new period from today. */
export type PlanChangeProration = "invoice_now" | "next_invoice" | "none" | "restart";

/** A provider's answer that asking again won't change, or "retry" when it may. */
export type BillingRefusal = PlanChangeRefusal | "retry";

export interface BillingProvider {
  readonly id: BillingProviderId;
  readonly env: BillingEnv;
  /** The Polar organization ID or Stripe account ID. */
  readonly account: string;
  readonly can: {
    /** One customer per email (Polar): the billing email form and the billing_email_* refusals. */
    uniqueCustomerEmail: boolean;
    /** Usage goes out priced, and the daily totals check runs (Stripe). */
    meterMoney: boolean;
    /** Overage bills on a monthly subscription of its own (Stripe directly). */
    separateOverage: boolean;
    /** Reconcile reads the subscription back instead of trusting the event (Stripe). */
    readBack: boolean;
    /** Cancel plan and Keep my plan in Settings > Plan (Stripe). */
    inAppCancel: boolean;
  };

  /**
   * The business's customer, found by its billing key or made. Null when the
   * deployment's credentials can't read or make customers, so checkout leaves
   * the customer to the provider (a Polar token without customers:write).
   */
  findOrCreateCustomer(input: { customer: CustomerRef; businessId: string; email: string; name: string | null; locale: string | null; requestId: string }): Promise<{ id: string; created: boolean } | null>;
  /** A checkout page for a plan, made out to the customer, or else to the email and billing key. */
  createCheckout(input: { customer: CustomerRef; email: string; price: PriceRef; businessId: string; requestId: string; metadata: Record<string, string>; successUrl: string; cancelUrl: string; locale: string | null }): Promise<{ id: string; url: string; expiresAt: Date | null }>;
  /** The subscription, or null when the provider doesn't know it. */
  getSubscription(id: string): Promise<ProviderSubscription | null>;

  /**
   * Moves a subscription to another price. `discount` says what becomes of its
   * discount: the new price's own (a promo plan's), removed (leaving a promo
   * plan), or kept as it is.
   */
  changePlan(input: { subscriptionId: string; to: PriceRef; discount: "price" | "remove" | "keep"; when: "now" | "renewal"; proration: PlanChangeProration; metadata?: Record<string, string>; requestId: string }): Promise<PlanChangeResult>;
  /** Cancels at the renewal, or now. Null once it has ended. */
  cancel(input: { subscriptionId: string; when: "renewal" | "now"; requestId: string }): Promise<ProviderSubscription | null>;
  /** Undoes a cancellation at the renewal. */
  resume(input: { subscriptionId: string; requestId: string }): Promise<ProviderSubscription>;
  /** Drops a change waiting for the renewal, so the plan stays as it is. */
  keepPlan(input: { subscriptionId: string; requestId: string }): Promise<ProviderSubscription>;
  /** At the renewal, moves to `then` with its discount (null removes one), or cancels: a promo plan's end. */
  endAtRenewal(input: { subscriptionId: string; then: PriceRef | "cancel"; requestId: string }): Promise<ProviderSubscription>;
  /** Removes the subscription's discount from its next billing cycle on. */
  removeDiscount(input: { subscriptionId: string; requestId: string }): Promise<ProviderSubscription>;
  /** Ends the subscription now, as for a business being deleted. */
  revoke(input: { subscriptionId: string; requestId: string }): Promise<"ended" | "already_ended">;

  /** The worker's startup check (Stripe): null when the credentials are the deployment's own account, else the account expected and the one found. */
  checkAccount?(): Promise<{ expected: string; found: string } | null>;

  /**
   * The plan's overage subscription, made once it goes live (Stripe directly).
   * One the provider ended after failed payments, or left unpaid, comes back
   * as unpaid while its invoice is open: no other is made until that invoice
   * is collected or forgiven.
   */
  ensureOverage?(input: { customerId: string; planSubscriptionId: string; businessId: string; currency: string }): Promise<{ subscriptionId: string } | { unpaidSubscriptionId: string }>;
  endOverage?(input: { subscriptionId: string; when: "period_end" | "now" }): Promise<void>;

  /**
   * Sends one usage event: `units` in the row's own unit (a call's seconds),
   * and `amountCents` priced at the plan's rate where the provider meters
   * money, null before usage is priced.
   */
  reportUsage(input: { customer: CustomerRef; businessId: string; kind: OverageKind; units: number; amountCents: number | null; occurredAt: Date; identifier: string }): Promise<"sent" | "duplicate">;
  /** What the provider's money meters hold for the customer between two times, in cents by kind (Stripe). */
  usageTotals?(input: { customerId: string; from: Date; to: Date }): Promise<Record<OverageKind, number>>;
  /** What creditBalance has credited the customer for each kind, in cents. */
  usageCredits?(input: { customerId: string }): Promise<Record<OverageKind, number>>;
  /** Credits the customer's balance with a correction a month's overage can't take; the identifier keys it. */
  creditBalance?(input: { customerId: string; kind: OverageKind; cents: number; currency: string; identifier: string }): Promise<void>;

  /** A page where the customer manages cards, invoices and billing details. */
  createPortalSession(input: { customer: CustomerRef; returnUrl: string; locale: string | null }): Promise<{ url: string }>;
  /** The refusal to tell the business for a provider's error, or undefined when trying again may work. */
  refusalFor(error: unknown): BillingRefusal | undefined;
  /** The business a customer's metadata names, for an event that names only the customer (Stripe's charges). Null when it names none. */
  businessOfCustomer?(customerId: string): Promise<string | null>;
  /** The invoice a payment paid, for a refund that names only the payment (Stripe's charges). Null when there's none. */
  invoiceOfPayment?(paymentRef: string): Promise<string | null>;
}

/** A webhook delivery whose signature checked out. */
export type VerifiedDelivery = { id: string; type: string; createdAt: Date; livemode: boolean | null; object: Record<string, unknown> };

/** What a billing event is about; other is one reconcile reads only for its customer. */
export type BillingEventKind = "subscription" | "payment" | "refund" | "checkout" | "dispute" | "usage_error" | "other";

/** A provider's event as reconcile reads it. */
export type NormalizedBillingEvent = {
  kind: BillingEventKind;
  /** From metadata, the checkout's reference or the billing key. */
  businessId: string | null;
  /** Whatever named the business, for the logs. */
  businessReference: string | null;
  /** A customer whose billing key names another business (Polar). */
  customerBusinessId: string | null;
  fields: {
    billingKey?: string; customerId?: string; subscriptionId?: string; priceRef?: string;
    plan?: string; planCode?: string; billingInterval?: BillingInterval; subscriptionState?: string;
    discountRef?: string | null; subscriptionModifiedAt?: string; periodStart?: string; periodEnd?: string;
    cancelAt?: string | null; nextChange?: { planCode: string; billingInterval: BillingInterval; at: string } | null; checkoutRequestId?: string; checkoutOutcome?: "completed" | "expired";
    payment?: { id: string; status: string; amountCents: number; refundedCents: number; currency: string; invoiceUrl: string | null; subscriptionId: string | null; description: string | null; occurredAt: string };
  };
  /**
   * What gets stored: the provider's object with the normalized fields beside it at
   * the top level, so a reconcile running the release before still reads it.
   */
  payload: Record<string, unknown>;
};

/** The prices a deployment's catalog sells, as the webhook and checkout read them. */
export interface PriceLinks {
  /** A standard plan's live price. */
  refFor(plan: string, interval: BillingInterval): string | null;
  /** Any sold plan, with its discount. */
  saleFor(planCode: string, interval: BillingInterval): PriceRef | null;
  /** The plan a price sells, retired ones too. */
  planFor(ref: string | null | undefined): { plan: string; code: string; interval: BillingInterval } | null;
  /** The metered price for one kind of overage (Stripe). */
  overageRef(kind: OverageKind): string | null;
}

export interface BillingWebhook {
  readonly provider: BillingProviderId;
  /** Throws BillingWebhookRefusal: an unconfigured secret, missing headers, a bad or old signature, the wrong mode, or a body that isn't an event. */
  verify(rawBody: string, headers: Headers): VerifiedDelivery;
  /** Null for an event LobbyStack doesn't use, answered 202 and not stored. */
  normalize(delivery: VerifiedDelivery, links: Pick<PriceLinks, "planFor">): NormalizedBillingEvent | null;
}

/** The calls `pnpm billing` and the daily catalog check make; the decisions are the domain's planner's. */
export interface BillingCatalogClient<Snapshot, Step> {
  readonly provider: BillingProviderId;
  readSnapshot(options?: { webhooks?: boolean }): Promise<Snapshot>;
  run(steps: readonly Step[], onStep?: (step: Step, secret: string | null) => void): Promise<{ webhookSecret: string | null }>;
}
