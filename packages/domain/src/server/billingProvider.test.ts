import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PolarCatalogClient } from "@lobbystack/providers/polar/polarCatalog";
import { billingProfileSchema } from "@lobbystack/shared";

import { desiredBillingPlans } from "./billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans } from "./billingPolar";
import { createFakePolar, seedPolarSetup } from "./billingPolar.testing";
import { plannerFor, polarPlanner, readBillingDeployment } from "./billingProvider";

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

  it("has a planner for Polar, and none for Stripe yet", () => {
    expect(plannerFor("polar")).toBe(polarPlanner);
    expect(polarPlanner.provider).toBe("polar");
    expect(() => plannerFor("stripe")).toThrow("from step 11 of the Stripe plan");
  });

  it("reads the deployment's provider and its sandbox or live account from its variables", () => {
    expect(readBillingDeployment({ POLAR_ORGANIZATION_ID: "org-1" })).toMatchObject({ provider: "polar", providerEnv: "live", env: "production", org: "org-1" });
    expect(readBillingDeployment({ POLAR_ORGANIZATION_ID: "org-1", POLAR_API_BASE_URL: "https://sandbox-api.polar.sh" })).toMatchObject({ provider: "polar", providerEnv: "sandbox", env: "sandbox" });
  });
});
