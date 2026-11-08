import { z } from "zod";

// Stripe's events as its webhooks deliver them (the Stripe plan's step 12).
// The endpoint pnpm billing makes sends snapshot events in STRIPE_API_VERSION,
// whose object the webhook normalizes; the meter error destination sends thin
// events, which name their object instead of carrying it.

/** A snapshot event: the object it's about, as it was when the event happened. */
export const stripeEventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  object: z.literal("event"),
  type: z.string().min(1).max(128),
  /** Seconds since the epoch. */
  created: z.number().int().positive(),
  livemode: z.boolean(),
  api_version: z.string().nullable().optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

export type StripeEventEnvelope = z.infer<typeof stripeEventSchema>;

/** A thin event: its type, when and where it happened, and the object it's about. */
export const stripeThinEventSchema = z.object({
  id: z.string().min(1).max(255),
  object: z.literal("v2.core.event"),
  type: z.string().min(1).max(128),
  /** An ISO 8601 time. */
  created: z.iso.datetime({ offset: true }),
  livemode: z.boolean(),
  related_object: z.object({ id: z.string(), type: z.string(), url: z.string().optional() }).nullable().optional(),
});

export type StripeThinEvent = z.infer<typeof stripeThinEventSchema>;
