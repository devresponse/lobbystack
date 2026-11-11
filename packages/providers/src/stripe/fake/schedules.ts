import type Stripe from "stripe";

import type { StripeApi } from "../client";
import { idOf, type FakeStripeContext } from "./context";
import { invalid, missing } from "./errors";

// Subscription schedules, which plan changes at the renewal and promo endings
// make (the Stripe plan's step 14): made from a subscription, given phases,
// and released. A test moves a subscription into its next phase with
// enterFakeSchedulePhase, as Stripe does at the renewal.

type PhaseParams = Stripe.SubscriptionScheduleUpdateParams.Phase;

/** Whether the account sells the price as metered, which takes no quantity. */
const isMetered = (fake: FakeStripeContext, price: string | undefined) => fake.state.catalog.prices.some((entry) => entry.id === price && entry.recurring?.usage_type === "metered");

/** A phase as Stripe answers it, from the update's parameters: a metered price without a quantity, as Stripe refuses one. */
function phaseOf(fake: FakeStripeContext, params: PhaseParams, start: number, end: number | null): Stripe.SubscriptionSchedule.Phase {
  for (const item of params.items ?? []) {
    if (item.quantity !== undefined && isMetered(fake, item.price)) throw invalid("Quantity should not be specified where usage_type is `metered`.", "phases[].items[].quantity");
  }
  return {
    start_date: start,
    end_date: end,
    items: (params.items ?? []).map((item) => ({ price: item.price, ...(isMetered(fake, item.price) ? {} : { quantity: item.quantity ?? 1 }) })),    discounts: Array.isArray(params.discounts) ? params.discounts.map((discount) => ({ coupon: discount.coupon ?? null, discount: null, promotion_code: null })) : [],
    metadata: (params.metadata ?? {}) as Record<string, string>,
  } as unknown as Stripe.SubscriptionSchedule.Phase;
}

const MONTH = 30 * 24 * 60 * 60;

/** subscriptionSchedules.create, update and release, on the fake's schedules. */
export function fakeSchedules(fake: FakeStripeContext): StripeApi["subscriptionSchedules"] {
  const held = (id: string) => {
    const schedule = fake.state.schedules.get(id);
    if (!schedule) throw missing("subscription_schedule", id);
    if (schedule.status === "released" || schedule.status === "canceled") throw invalid(`You cannot update a subscription schedule that is ${schedule.status}.`);
    return schedule;
  };
  return {
    /** From a subscription: one phase, its plan's items and discounts to the period's end. */
    async create(params: Stripe.SubscriptionScheduleCreateParams = {}, options: Stripe.RequestOptions = {}) {
      return await fake.call("subscriptionSchedules.create", params, options.idempotencyKey ?? null, () => {
        const subscription = params.from_subscription ? fake.state.subscriptions.get(params.from_subscription) : undefined;
        if (!subscription) throw missing("subscription", params.from_subscription ?? "", "from_subscription");
        if (subscription.schedule) throw invalid(`You cannot migrate a subscription that is already attached to a schedule: \`${idOf(subscription.schedule)}\`.`, "from_subscription");
        const item = subscription.items.data[0]!;
        const id = fake.nextId("sub_sched");
        const coupons = subscription.discounts.flatMap((discount) => (typeof discount === "string" ? [] : [idOf(discount.source?.coupon ?? null)].filter((coupon): coupon is string => coupon !== null)));
        const schedule = {
          id,
          object: "subscription_schedule",
          subscription: subscription.id,
          customer: subscription.customer,
          status: "active",
          end_behavior: "release",
          released_subscription: null,
          phases: [phaseOf(fake, { items: subscription.items.data.map((entry) => ({ price: entry.price.id, ...(entry.price.recurring?.usage_type === "metered" ? {} : { quantity: 1 }) })), discounts: coupons.map((coupon) => ({ coupon })) }, item.current_period_start, item.current_period_end)],
        } as unknown as Stripe.SubscriptionSchedule;
        fake.state.schedules.set(id, schedule);
        fake.state.subscriptions.set(subscription.id, { ...subscription, schedule: id } as Stripe.Subscription);
        return schedule;
      });
    },
    /** Its phases, each starting where the one before ends; a phase without an end runs for a period. */
    async update(id: string, params: Stripe.SubscriptionScheduleUpdateParams = {}, options: Stripe.RequestOptions = {}) {
      return await fake.call("subscriptionSchedules.update", { id, ...params }, options.idempotencyKey ?? null, () => {
        const schedule = held(id);
        let start = schedule.phases[0]?.start_date ?? fake.clock.now();
        const phases = (params.phases ?? []).map((phase) => {
          const begins = typeof phase.start_date === "number" ? phase.start_date : start;
          const ends = typeof phase.end_date === "number" ? phase.end_date : begins + MONTH;
          start = ends;
          return phaseOf(fake, phase, begins, ends);
        });
        const updated = { ...schedule, ...(params.end_behavior ? { end_behavior: params.end_behavior } : {}), ...(params.phases ? { phases } : {}) } as Stripe.SubscriptionSchedule;
        fake.state.schedules.set(id, updated);
        return updated;
      });
    },
    /** Lets the subscription go on its own, as it is now. */
    async release(id: string, params: Stripe.SubscriptionScheduleReleaseParams = {}, options: Stripe.RequestOptions = {}) {
      return await fake.call("subscriptionSchedules.release", { id, ...params }, options.idempotencyKey ?? null, () => {
        const schedule = held(id);
        const subscriptionId = idOf(schedule.subscription);
        const released = { ...schedule, status: "released", released_subscription: subscriptionId, subscription: null } as Stripe.SubscriptionSchedule;
        fake.state.schedules.set(id, released);
        const subscription = subscriptionId ? fake.state.subscriptions.get(subscriptionId) : undefined;
        if (subscription) fake.state.subscriptions.set(subscription.id, { ...subscription, schedule: null } as Stripe.Subscription);
        return released;
      });
    },
  } as unknown as StripeApi["subscriptionSchedules"];
}

/**
 * The renewal under a schedule: the subscription takes the next phase's
 * items and discounts, and a schedule with no phase after it releases it. An
 * item on a price the subscription already has keeps its ID.
 */
export function enterFakeSchedulePhase(fake: FakeStripeContext, subscriptionId: string): Stripe.Subscription {
  const subscription = fake.state.subscriptions.get(subscriptionId);
  const scheduleId = subscription ? idOf(subscription.schedule) : null;
  const schedule = scheduleId ? fake.state.schedules.get(scheduleId) : undefined;
  if (!subscription || !schedule) throw new Error(`Subscription ${subscriptionId} has no schedule.`);
  const item = subscription.items.data[0]!;
  const index = schedule.phases.findIndex((phase) => phase.start_date >= item.current_period_end);
  const phase = schedule.phases[index];
  if (!phase) throw new Error(`Schedule ${schedule.id} has no phase after the period.`);
  const end = phase.end_date ?? phase.start_date + MONTH;
  const data = phase.items.map((entry, position) => {
    const price = idOf(entry.price)!;
    const catalog = fake.state.catalog.prices.find((found) => found.id === price);
    const same = subscription.items.data.find((found) => found.price.id === price);
    // The plan's item takes the first price; any other item keeps its own, or is new.
    const base = same ?? (position === 0 ? item : { ...item, id: `si_${subscriptionId}_${position}`, quantity: undefined });
    return { ...base, price: { ...base.price, id: price, recurring: { ...base.price.recurring, interval: catalog?.recurring?.interval ?? base.price.recurring?.interval ?? "month", usage_type: catalog?.recurring?.usage_type ?? base.price.recurring?.usage_type ?? "licensed" } }, current_period_start: phase.start_date, current_period_end: end };
  });
  const moved = {
    ...subscription,
    items: { ...subscription.items, data },    discounts: (phase.discounts ?? []).map((discount, position) => ({ id: `di_${subscriptionId}_${position}`, object: "discount", source: { coupon: idOf(discount.coupon), type: "coupon" }, subscription: subscriptionId, start: phase.start_date, end: null })),
    metadata: { ...subscription.metadata, ...(phase.metadata ?? {}) },
    // A schedule without a phase after this one lets the subscription go, as end_behavior release does.
    schedule: index === schedule.phases.length - 1 ? null : schedule.id,
  } as unknown as Stripe.Subscription;
  fake.state.subscriptions.set(subscriptionId, moved);
  if (moved.schedule === null) fake.state.schedules.set(schedule.id, { ...schedule, status: "released", released_subscription: subscriptionId, subscription: null } as Stripe.SubscriptionSchedule);
  fake.clock.advance(Math.max(0, phase.start_date - fake.clock.now()));
  return moved;
}
