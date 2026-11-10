import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PolarCatalogClient } from "@lobbystack/providers/polar/polarCatalog";
import { billingProfileSchema } from "@lobbystack/shared";

import { billingCatalogDeployment, desiredBillingPlans } from "./billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans } from "./billingPolar";
import { createFakePolar, seedPolarSetup } from "./billingPolar.testing";
import { plannerFor, polarPlanner, readBillingDeployment } from "./billingProvider";
import { stripePlanner } from "./billingStripe";

const profile = billingProfileSchema.parse(JSON.parse(readFileSync(new URL("../../../../brands/alloplace/billing.json", import.meta.url), "utf8")));
const plans = desiredBillingPlans(profile);
const input = { brand: "alloplace", profile, plans, webhookUrl: "https://demo.alloplace.com/api/webhooks/polar" };
const options = { adopt: true, allowReplace: true, allowArchive: true };

describe("the catalog seam", () => {
  it("plans Polar's catalog with today's functions, unchanged, and the client runs the plan", async () => {
    const fake = createFakePolar();
    await seedPolarSetup(fake);
    const client = new PolarCatalogClient({ token: "polar_oat_test", baseUrl: "https://sandbox-api.polar.sh", fetch: fake.fetch, sleep: async () => undefined });
    expect(client.provider).toBe("polar");
    const snapshot = await client.readSnapshot();
    const desired = polarPlanner.desired(input);
    expect(desired).toEqual(desiredPolarCatalog(input));
    const planned = polarPlanner.plan({ desired, snapshot, options });
    expect(planned).toEqual(planPolarChanges({ catalog: desired, snapshot, options }));
    expect(planned.steps.length).toBeGreaterThan(0);

    const ran: string[] = [];
    await client.run(planned.steps, (step) => ran.push(step.subject));
    expect(ran).toEqual(planned.steps.map((step) => step.subject));
    const after = await client.readSnapshot();
    expect(polarPlanner.plan({ desired, snapshot: after, options }).steps).toEqual([]);
    expect(polarPlanner.linkBody({ desired, snapshot: after, plans })).toEqual(polarLinkPlans({ catalog: desired, plans, snapshot: after }));
  });

  it("has a planner for each provider", () => {
    expect(plannerFor("polar")).toBe(polarPlanner);
    expect(polarPlanner.provider).toBe("polar");
    expect(plannerFor("stripe")).toBe(stripePlanner);
    expect(stripePlanner.provider).toBe("stripe");
  });

  it("reads the deployment's provider and its sandbox or live account from its variables", () => {
    expect(readBillingDeployment({ POLAR_ORGANIZATION_ID: "org-1" })).toMatchObject({ provider: "polar", providerEnv: "live", account: "org-1", polar: { env: "production", org: "org-1" }, stripe: null });
    expect(readBillingDeployment({ POLAR_ORGANIZATION_ID: "org-1", POLAR_API_BASE_URL: "https://sandbox-api.polar.sh" })).toMatchObject({ provider: "polar", providerEnv: "sandbox", polar: { env: "sandbox" } });
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    // During a rotation the secret holds two; the endpoint's is the first.
    const stripe = { BILLING_PROVIDER: "stripe", STRIPE_API_KEY: "rk_test_admin123", STRIPE_ACCOUNT_ID: "acct_1", STRIPE_WEBHOOK_SECRET: "whsec_new, whsec_old", POLAR_ORGANIZATION_ID: "org-1" };
    expect(readBillingDeployment(stripe)).toEqual({ provider: "stripe", providerEnv: "sandbox", account: "acct_1", polar: null, stripe: { env: "sandbox", account: "acct_1", secretSha256: sha256("whsec_new") } });
    expect(readBillingDeployment({ ...stripe, STRIPE_API_KEY: "rk_live_admin123" }, { withSecret: false })).toMatchObject({ providerEnv: "live", stripe: { env: "live", secretSha256: null } });
    expect(billingCatalogDeployment("realinfobot", stripe)).toEqual({ brand: "realinfobot", stripe: { env: "sandbox", account: "acct_1", secretSha256: sha256("whsec_new") } });
    expect(billingCatalogDeployment("alloplace", { POLAR_ORGANIZATION_ID: "org-1" })).toMatchObject({ brand: "alloplace", polar: { org: "org-1" } });
  });
});
