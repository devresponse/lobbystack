import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Check, Minus } from "lucide-react";
import type { BillingPlanList } from "@lobbystack/shared";
import { FREE_CONTENT_RETENTION_MAX_DAYS, contentRetentionDaysForPlan } from "@lobbystack/shared/product-capabilities";

import { findPlan, planValues, storageSize } from "@/lib/billing-plans";

type ComparisonValue =
  | boolean
  | {
      key: string;
    }
  | {
      includedKey: string;
      thenKey?: string;
      params?: Record<string, string | number>;
      thenParams?: Record<string, string | number>;
    };

type ComparisonRow = {
  key: string;
  free: ComparisonValue;
  starter?: ComparisonValue;
  pro: ComparisonValue;
  enterprise: ComparisonValue;
};

type ComparisonGroup = {
  key: string;
  rows: ComparisonRow[];
};

/**
 * The usage rows come from the deployment's plan list, so a catalog change
 * shows here in its currency. A custom allowance reads as custom.
 */
function usageRows(plans: BillingPlanList, locale: string): ComparisonRow[] {
  const custom = { key: "common.custom" };
  const storage = (bytes: number | null | undefined): ComparisonValue => {
    if (bytes === null || bytes === undefined) return custom;
    const size = storageSize(bytes, locale);
    return { includedKey: size.unit === "GB" ? "usage.knowledgeStorage.gigabytes" : "usage.knowledgeStorage.megabytes", params: { amount: size.amount } };
  };
  const paid = (slug: "starter" | "pro") => {
    const offer = findPlan(plans, slug);
    const values = planValues(offer, plans.currency, locale);
    const allowance = (
      row: "voiceMinutes" | "outboundCalls" | "alertSms",
      included: number | null | undefined,
      count: number,
      rate: string,
    ): ComparisonValue => included === null || included === undefined
      ? custom
      : { includedKey: `usage.${row}.included`, params: { count }, ...(rate ? { thenKey: `usage.${row}.then`, thenParams: { rate } } : {}) };
    return {
      voiceMinutes: allowance("voiceMinutes", offer?.included.voiceSeconds, values.minutes, values.voiceRate),
      outboundCalls: allowance("outboundCalls", offer?.included.outboundCallAttempts, values.outboundCallAttempts, values.outboundCallRate),
      alertSms: allowance("alertSms", offer?.included.alertSmsSegments, values.alertSmsSegments, values.alertSmsRate),
      knowledgeStorage: storage(offer?.included.knowledgeStorageBytes),
      phoneNumbers: offer?.included.businessNumbers === null || offer?.included.businessNumbers === undefined
        ? custom
        : { includedKey: "usage.phoneNumbers.dedicated", params: { count: values.businessNumbers } },
    };
  };
  const free = findPlan(plans, "free_cloud");
  const starter = paid("starter");
  const pro = paid("pro");
  return [
    {
      key: "voiceMinutes",
      free: { includedKey: "usage.voiceMinutes.freeIncluded", params: { minutes: planValues(free, plans.currency, locale).minutes } },
      starter: starter.voiceMinutes,
      pro: pro.voiceMinutes,
      enterprise: custom,
    },
    { key: "outboundCalls", free: false, starter: starter.outboundCalls, pro: pro.outboundCalls, enterprise: custom },
    { key: "alertSms", free: false, starter: starter.alertSms, pro: pro.alertSms, enterprise: custom },
    { key: "knowledgeStorage", free: storage(free?.included.knowledgeStorageBytes), starter: starter.knowledgeStorage, pro: pro.knowledgeStorage, enterprise: custom },
    { key: "phoneNumbers", free: false, starter: starter.phoneNumbers, pro: pro.phoneNumbers, enterprise: { key: "common.multiple" } },
  ];
}

const otherGroups: ComparisonGroup[] = [
  {
    key: "core",
    rows: [
      {
        key: "callAnswering",
        free: { key: "common.browserTesting" },
        pro: true,
        enterprise: true,
      },
      {
        key: "callerDetails",
        free: true,
        pro: true,
        enterprise: true,
      },
      {
        key: "knowledgeAnswers",
        free: true,
        pro: true,
        enterprise: true,
      },
      {
        key: "workflows",
        free: true,
        pro: true,
        enterprise: true,
      },
      {
        key: "spamFiltering",
        free: true,
        pro: true,
        enterprise: true,
      },
      {
        key: "shortCalls",
        free: true,
        pro: true,
        enterprise: true,
      },
      {
        key: "concurrentCalls",
        free: true,
        pro: true,
        enterprise: true,
      },
      {
        key: "multilingual",
        free: true,
        pro: true,
        enterprise: true,
      },
    ],
  },
  {
    key: "booking",
    rows: [
      {
        key: "appointmentBooking",
        free: { key: "common.unlimited" },
        pro: { key: "common.unlimited" },
        enterprise: { key: "common.unlimited" },
      },
      {
        key: "confirmationTexts",
        free: false,
        pro: true,
        enterprise: true,
      },
      {
        key: "googleCalendar",
        free: true,
        pro: true,
        enterprise: true,
      },
    ],
  },
  {
    key: "routing",
    rows: [
      {
        key: "urgentHandoff",
        free: false,
        pro: true,
        enterprise: true,
      },
      {
        key: "callTransfers",
        free: false,
        pro: true,
        enterprise: true,
      },
      {
        key: "afterHours",
        free: false,
        pro: true,
        enterprise: true,
      },
    ],
  },
  {
    key: "notifications",
    rows: [
      {
        key: "emailNotifications",
        free: true,
        pro: true,
        enterprise: true,
      },
      {
        key: "smsNotifications",
        free: false,
        pro: true,
        enterprise: true,
      },
    ],
  },
  {
    key: "data",
    rows: [
      {
        key: "summaries",
        free: { key: "common.unlimited" },
        pro: { key: "common.unlimited" },
        enterprise: { key: "common.unlimited" },
      },
      {
        key: "history",
        free: { key: "common.unlimited" },
        pro: { key: "common.unlimited" },
        enterprise: { key: "common.unlimited" },
      },
      {
        key: "contentRetention",
        free: { includedKey: "data.contentRetention.free", params: { days: FREE_CONTENT_RETENTION_MAX_DAYS } },
        starter: { includedKey: "data.contentRetention.paid", params: { days: contentRetentionDaysForPlan("starter", "transcripts") } },
        pro: { includedKey: "data.contentRetention.paid", params: { days: contentRetentionDaysForPlan("pro", "transcripts") } },
        enterprise: { key: "common.custom" },
      },
      {
        key: "callerProfiles",
        free: true,
        pro: true,
        enterprise: true,
      },
      {
        key: "contacts",
        free: { key: "common.unlimited" },
        pro: { key: "common.unlimited" },
        enterprise: { key: "common.unlimited" },
      },
      {
        key: "websiteImport",
        free: true,
        pro: true,
        enterprise: true,
      },
    ],
  },
  {
    key: "deployment",
    rows: [
      {
        key: "hosting",
        free: { key: "deployment.hosting.managed" },
        pro: { key: "deployment.hosting.managed" },
        enterprise: { key: "deployment.hosting.enterprise" },
      },
      {
        key: "usageBilling",
        free: false,
        pro: true,
        enterprise: true,
      },
      {
        key: "support",
        free: { key: "deployment.support.community" },
        starter: { key: "deployment.support.email" },
        pro: { key: "deployment.support.priority" },
        enterprise: { key: "deployment.support.dedicated" },
      },
    ],
  },
];

type OnboardingT = ReturnType<typeof useTranslation<"onboarding">>["t"];

function ComparisonCell({ t, value }: { t: OnboardingT; value: ComparisonValue }) {
  if (typeof value === "boolean") {
    return value ? (
      <span><Check aria-hidden="true" className="mx-auto size-4 text-foreground/60" /><span className="sr-only">{t("plan.comparison.values.common.included")}</span></span>
    ) : (
      <span><Minus aria-hidden="true" className="mx-auto size-4 text-muted-foreground/30" /><span className="sr-only">{t("plan.comparison.values.common.notIncluded")}</span></span>
    );
  }

  if ("key" in value) {
    const label = t(`plan.comparison.values.${value.key}`);
    return (
      <span className={label === "-" ? "text-muted-foreground/40" : "text-muted-foreground"}>
        {label}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col gap-0.5 leading-tight">
      <span className="font-medium text-foreground">
        {t(`plan.comparison.values.${value.includedKey}`, value.params ?? {})}
      </span>
      {value.thenKey ? (
        <span className="text-xs text-muted-foreground">
          {t(`plan.comparison.values.${value.thenKey}`, value.thenParams ?? {})}
        </span>
      ) : null}
    </span>
  );
}

export function OnboardingPlanComparison({ locale, plans, t }: { locale: string; plans: BillingPlanList; t: OnboardingT }) {
  const comparisonGroups: ComparisonGroup[] = [{ key: "usage", rows: usageRows(plans, locale) }, ...otherGroups];
  const freeMinutes = planValues(findPlan(plans, "free_cloud"), plans.currency, locale).minutes;
  return (
    <section id="compare">
      <h2 className="mb-4 text-center font-heading text-2xl font-semibold tracking-tighter md:text-3xl">
        {t("plan.compareTitle")}
      </h2>
      <p className="mx-auto mb-12 max-w-lg text-center text-sm leading-relaxed text-muted-foreground">
        {t("plan.compareDescription", { minutes: freeMinutes })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border/60">
              <th className="pr-8 pb-4 text-left text-xs font-medium text-muted-foreground">{t("plan.featureHeader")}</th>
              <th className="w-[150px] px-4 pb-4 text-center text-xs font-medium text-muted-foreground">{t("plan.tiers.free_cloud.name")}</th>
              <th className="w-[150px] px-4 pb-4 text-center text-xs font-medium text-muted-foreground">{t("plan.tiers.starter.name")}</th>
              <th className="w-[150px] px-4 pb-4 text-center text-xs font-medium text-muted-foreground"><span className="inline-flex items-center gap-1.5">{t("plan.tiers.pro.name")}<span className="rounded-full bg-foreground px-1.5 py-px text-[10px] font-medium text-background">{t("plan.popular")}</span></span></th>
              <th className="w-[150px] px-4 pb-4 text-center text-xs font-medium text-muted-foreground">{t("plan.tiers.enterprise.name")}</th>
            </tr>
          </thead>
          <tbody>
            {comparisonGroups.map((group) => (
              <Fragment key={group.key}>
                <tr><td className="pt-8 pb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase" colSpan={5}>{t(`plan.comparison.groups.${group.key}`)}</td></tr>
                {group.rows.map((row) => (
                  <tr className="border-b border-border/40 last:border-0" key={row.key}>
                    <td className="py-3 pr-8 text-foreground">{t(`plan.comparison.features.${row.key}`)}</td>
                    {([row.free, row.starter ?? row.pro, row.pro, row.enterprise] as ComparisonValue[]).map((value, index) => <td className="px-4 py-3 text-center" key={index}><ComparisonCell t={t} value={value} /></td>)}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
