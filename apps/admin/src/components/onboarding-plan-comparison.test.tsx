// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { afterEach, expect, it } from "vitest";
import { builtInBillingPlanList } from "@lobbystack/shared";
import en from "../../public/locales/en/onboarding.json";
import fr from "../../public/locales/fr/onboarding.json";
import { OnboardingPlanComparison } from "./onboarding-plan-comparison";

afterEach(cleanup);

it.each(["en", "fr"] as const)("describes supported capabilities in %s", async (locale) => {
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { en: { onboarding: en }, fr: { onboarding: fr } } });
  const t = i18n.getFixedT(locale, "onboarding");
  render(<OnboardingPlanComparison locale={locale} plans={builtInBillingPlanList()} t={t} />);
  expect(screen.queryByText(/Outlook/)).toBeNull();
  expect(screen.getByText(/30 browser minutes|30 minutes dans le navigateur/)).toBeTruthy();
  const numbers = screen.getByText(t("plan.comparison.features.phoneNumbers")).closest("tr")!;
  expect(within(numbers).getAllByRole("cell")[1]?.textContent).toBe(t("plan.comparison.values.common.notIncluded"));
  expect(screen.queryByText(/AI SMS|SMS IA|Outbound|sortants|Missed-call|appels manqués|Multi-location|multisite/i)).toBeNull();
  for (const feature of ["confirmationTexts", "smsNotifications", "alertSms", "outboundCalls"]) {
    const row = screen.getByText(t(`plan.comparison.features.${feature}`)).closest("tr")!;
    expect(within(row).getAllByRole("cell")[1]?.textContent).toBe(t("plan.comparison.values.common.notIncluded"));
  }
  const retention = screen.getByText(t("plan.comparison.features.contentRetention")).closest("tr")!;
  const retentionCells = within(retention).getAllByRole("cell");
  expect(retentionCells[1]?.textContent).toBe(t("plan.comparison.values.data.contentRetention.free", { days: 30 }));
  expect(retentionCells[2]?.textContent).toBe(t("plan.comparison.values.data.contentRetention.paid", { days: 90 }));
  expect(retentionCells[3]?.textContent).toBe(t("plan.comparison.values.data.contentRetention.paid", { days: 90 }));
});

it("shows the plan list's allowances and rates in its currency", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { onboarding: en } } });
  const t = i18n.getFixedT("en", "onboarding");
  const plans = builtInBillingPlanList();
  plans.currency = "cad";
  const free = plans.plans.find((plan) => plan.slug === "free_cloud")!;
  free.included.voiceSeconds = 3_600;
  const pro = plans.plans.find((plan) => plan.slug === "pro")!;
  pro.included = { ...pro.included, voiceSeconds: 60, businessNumbers: 2, knowledgeStorageBytes: 2 * 1024 ** 3 };
  pro.overageRates.voiceMinuteCents = 15;
  pro.overageRates.alertSmsSegmentCents = null;
  render(<OnboardingPlanComparison locale="en" plans={plans} t={t} />);
  expect(screen.getByText(/Test 60 browser voice minutes on Free/)).toBeTruthy();
  const cells = (feature: string) => within(screen.getByText(t(`plan.comparison.features.${feature}`)).closest("tr")!).getAllByRole("cell").map((cell) => cell.textContent);
  expect(cells("voiceMinutes").slice(1)).toEqual(["60 browser minutes", "150 includedthen CA$0.20/min", "1 includedthen CA$0.15/min", "Custom"]);
  // Without an overage rate there is no "then" line.
  expect(cells("alertSms")[3]).toBe("200 included");
  expect(cells("knowledgeStorage").slice(1)).toEqual(["1 MB", "5 MB", "2 GB", "Custom"]);
  expect(cells("phoneNumbers").slice(1)).toEqual([t("plan.comparison.values.common.notIncluded"), "1 dedicated", "2 dedicated", "Multiple"]);
});
