import { PACK_CHECKOUT_CLOSED_FOR_PLAN } from "@lobbystack/shared";

import type { Row, WaitSpec } from "./operations";

// The work a command can wait on, and how each tells it's over and whether it failed.

// The API's reason, without its full stop, so it reads inside a sentence.
const reason = (data: Row) => (typeof data.error === "string" && data.error.trim() ? data.error.trim().replace(/\.$/, "") : "no reason was given");

export const claimWait: WaitSpec = {
  operation: "getPhoneNumberClaim",
  param: "claim_id",
  done: (data) => data.status === "claimed" || data.status === "failed",
  failed: (data) => (data.status === "failed" ? `The claim failed: ${reason(data)}. Search again for another number.` : undefined),
};

export const checkoutWait: WaitSpec = {
  operation: "getCheckout",
  param: "checkout_id",
  done: (data) => data.status === "ready" || data.status === "changed" || data.status === "error",
  failed: (data) => (data.status === "error" ? `The billing provider couldn't make the checkout page or change the plan: ${reason(data)}. Start another checkout.` : undefined),
};

// A plan the business bought started while the pack's checkout was open, which closed it. Another checkout's pack would
// end a monthly plan, and a yearly one refuses it, so the CLI doesn't suggest one.
const closedForPlan = (data: Row) => typeof data.error === "string" && data.error.trim() === PACK_CHECKOUT_CLOSED_FOR_PLAN;

export const packCheckoutWait: WaitSpec = {
  operation: "getPackCheckout",
  param: "checkout_id",
  done: (data) => ["ready", "paid", "failed", "expired"].includes(String(data.status)),
  failed: (data) => (data.status !== "failed" && data.status !== "expired" ? undefined
    : closedForPlan(data) ? "A plan the business bought started, so the pack's checkout closed. A pack bought now would end a monthly plan; a yearly one has to end first."
    : data.status === "failed" ? `The pack's checkout failed: ${reason(data)}. Start another checkout.`
    : `The pack's checkout expired: ${reason(data)}. Start another checkout.`),
};

export const subscriptionChangeWait: WaitSpec = {
  operation: "getSubscriptionChange",
  param: "change_id",
  done: (data) => data.status === "changed" || data.status === "error",
  failed: (data) => (data.status === "error" ? `The billing provider didn't change the subscription: ${reason(data)}.` : undefined),
};

export const sourceWait: WaitSpec = {
  operation: "getKnowledgeSource",
  param: "source_id",
  done: (data) => !["pending", "processing"].includes(String(data.status)),
  failed: (data) => (data.status === "error" ? `Reading it failed: ${reason(data)}.` : data.status === "cancelled" ? "Reading it was cancelled." : undefined),
};
