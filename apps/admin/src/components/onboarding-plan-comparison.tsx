import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Check, Minus } from "lucide-react";
import { cloudBillingPlanSlugs, isPlanDisplayText, type BillingDisplay, type BillingPlanList, type BillingPlanOffer, type CloudBillingPlanSlug, type PlanDisplayCell, type PlanDisplayRowName } from "@lobbystack/shared";
import { FREE_CONTENT_RETENTION_MAX_DAYS, MIN_BILLABLE_VOICE_DURATION_SECONDS, contentRetentionDaysForPlan } from "@lobbystack/shared/product-capabilities";

import { useBranding } from "@/components/branding-provider";
import { findPlan, planValues, storageSize } from "@/lib/billing-plans";
import { displayText, pageTextValues, planCards, planTextValues, type PlanDisplayTranslate } from "@/lib/plan-display";

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
    }
  // Words from billing.json's display section, already in the visitor's language.
  | {
      text: string;
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
  // Receptionists active at once, the default included.
  const receptionists = (count: number | null | undefined): ComparisonValue => count === null || count === undefined ? custom : { includedKey: "usage.receptionists.included", params: { count } };
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
      receptionists: receptionists(offer?.included.receptionists),
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
    { key: "receptionists", free: receptionists(free?.included.receptionists), starter: starter.receptionists, pro: pro.receptionists, enterprise: custom },
    { key: "outboundCalls", free: false, starter: starter.outboundCalls, pro: pro.outboundCalls, enterprise: custom },
    { key: "alertSms", free: false, starter: starter.alertSms, pro: pro.alertSms, enterprise: custom },
    { key: "knowledgeStorage", free: storage(free?.included.knowledgeStorageBytes), starter: starter.knowledgeStorage, pro: pro.knowledgeStorage, enterprise: custom },
    { key: "phoneNumbers", free: false, starter: starter.phoneNumbers, pro: pro.phoneNumbers, enterprise: { key: "common.multiple" } },
  ];
}

/** How long each plan keeps transcripts and recordings, from the code that deletes them. */
const contentRetention: Omit<ComparisonRow, "key"> = {
  free: { includedKey: "data.contentRetention.free", params: { days: FREE_CONTENT_RETENTION_MAX_DAYS } },
  starter: { includedKey: "data.contentRetention.paid", params: { days: contentRetentionDaysForPlan("starter", "transcripts") } },
  pro: { includedKey: "data.contentRetention.paid", params: { days: contentRetentionDaysForPlan("pro", "transcripts") } },
  enterprise: { key: "common.custom" },
};

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
      { key: "contentRetention", ...contentRetention },
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

/** A row as the table shows it: its label, and each plan's value. */
type TableRow = { id: string; label: string; cells: Partial<Record<CloudBillingPlanSlug, ComparisonValue>> };
type TableGroup = { id: string; title: string; rows: TableRow[] };

/** The label each row billing.json can name takes from the built-in words. */
const rowFeatures: Record<PlanDisplayRowName, string> = {
  voiceMinutes: "voiceMinutes",
  receptionists: "receptionists",
  businessNumbers: "phoneNumbers",
  alertSmsSegments: "alertSms",
  outboundCallAttempts: "outboundCalls",
  chatAiUnits: "chatAiUnits",
  knowledgeStorage: "knowledgeStorage",
  contentRetention: "contentRetention",
  shortCalls: "shortCalls",
};

/** A built-in row's label: the shortest billed call comes from the code that bills calls. */
function featureLabel(t: OnboardingT, feature: string): string {
  return t(`plan.comparison.features.${feature}`, feature === "shortCalls" ? { seconds: MIN_BILLABLE_VOICE_DURATION_SECONDS } : {});
}

function builtInGroups(plans: BillingPlanList, locale: string, t: OnboardingT): TableGroup[] {
  return [{ key: "usage", rows: usageRows(plans, locale) }, ...otherGroups].map((group) => ({
    id: group.key,
    title: t(`plan.comparison.groups.${group.key}`),
    // Starter shares Pro's value wherever the row gives it none.
    rows: group.rows.map((row) => ({ id: row.key, label: featureLabel(t, row.key), cells: { free_cloud: row.free, starter: row.starter ?? row.pro, pro: row.pro, enterprise: row.enterprise } })),
  }));
}

/**
 * What a plan gets in a row the page fills: an allowance from the plan list,
 * where none reads as not included and a custom one as custom, or a row from
 * the code that enforces it. A plan without a business number calls from the
 * browser only, so its minutes say so.
 */
function filledCell(row: PlanDisplayRowName, plan: CloudBillingPlanSlug, offer: BillingPlanOffer | undefined, currency: string, locale: string): ComparisonValue {
  const custom = { key: "common.custom" };
  const included = offer?.included;
  const values = planValues(offer, currency, locale);
  const counted = (value: number | null | undefined, includedKey: string, then?: { key: string; rate: string }): ComparisonValue =>
    value === null || value === undefined ? custom : value === 0 ? false : { includedKey, params: { count: value }, ...(then?.rate ? { thenKey: then.key, thenParams: { rate: then.rate } } : {}) };
  switch (row) {
    case "voiceMinutes": {
      const seconds = included?.voiceSeconds;
      if (seconds === null || seconds === undefined) return custom;
      const minutes = Math.floor(seconds / 60);
      const then = values.voiceRate ? { thenKey: "usage.voiceMinutes.then", thenParams: { rate: values.voiceRate } } : {};
      return included?.businessNumbers === 0 ? { includedKey: "usage.voiceMinutes.freeIncluded", params: { minutes }, ...then } : { includedKey: "usage.voiceMinutes.included", params: { count: minutes }, ...then };
    }
    case "receptionists":
      return counted(included?.receptionists, "usage.receptionists.included");
    case "businessNumbers":
      return included?.businessNumbers === null || included?.businessNumbers === undefined ? { key: "common.multiple" } : counted(included.businessNumbers, "usage.phoneNumbers.dedicated");
    case "alertSmsSegments":
      return counted(included?.alertSmsSegments, "usage.alertSms.included", { key: "usage.alertSms.then", rate: values.alertSmsRate });
    case "outboundCallAttempts":
      return counted(included?.outboundCallAttempts, "usage.outboundCalls.included", { key: "usage.outboundCalls.then", rate: values.outboundCallRate });
    case "chatAiUnits":
      return counted(included?.chatAiUnits, "usage.chatAiUnits.included");
    case "knowledgeStorage": {
      const bytes = included?.knowledgeStorageBytes;
      if (bytes === null || bytes === undefined) return custom;
      const size = storageSize(bytes, locale);
      return { includedKey: size.unit === "GB" ? "usage.knowledgeStorage.gigabytes" : "usage.knowledgeStorage.megabytes", params: { amount: size.amount } };
    }
    case "contentRetention":
      return (plan === "free_cloud" ? contentRetention.free : contentRetention[plan]) ?? contentRetention.pro;
    case "shortCalls":
      return true;
  }
}

/** The comparison as billing.json's display section lays it out, in its order. */
function displayGroups(comparison: NonNullable<BillingDisplay["comparison"]>, plans: BillingPlanList, locale: string, t: OnboardingT, appName: string): TableGroup[] {
  const translate: PlanDisplayTranslate = (key, options) => t(key, options ?? {});
  const page = pageTextValues(plans, locale, translate, appName);
  const offers = Object.fromEntries(cloudBillingPlanSlugs.map((plan) => [plan, findPlan(plans, plan)])) as Record<CloudBillingPlanSlug, BillingPlanOffer | undefined>;
  // A plan's cell prints that plan's values, such as {{voiceMinutes}}.
  const planText = Object.fromEntries(cloudBillingPlanSlugs.map((plan) => [plan, planTextValues(offers[plan], plans.currency, locale, translate, appName)])) as Record<CloudBillingPlanSlug, Record<string, string>>;
  const cell = (value: PlanDisplayCell, plan: CloudBillingPlanSlug): ComparisonValue =>
    typeof value === "boolean" ? value : isPlanDisplayText(value) ? { text: displayText(value, locale, planText[plan]) } : { key: `common.${value}` };
  return comparison.map((group, groupIndex) => ({
    id: String(groupIndex),
    title: displayText(group.group, locale, page),
    rows: group.rows.map((row, rowIndex) => {
      const name = typeof row === "string" ? row : "row" in row ? row.row : null;
      const label = typeof row !== "string" && row.label ? displayText(row.label, locale, page) : name ? featureLabel(t, rowFeatures[name]) : "";
      const given = typeof row === "string" ? {} : row.values ?? {};
      const cells: TableRow["cells"] = {};
      for (const plan of cloudBillingPlanSlugs) {
        const value = given[plan];
        if (value !== undefined) cells[plan] = cell(value, plan);
        else if (name) cells[plan] = filledCell(name, plan, offers[plan], plans.currency, locale);
      }
      return { id: `${groupIndex}.${rowIndex}`, label, cells };
    }),
  }));
}

function ComparisonCell({ t, value }: { t: OnboardingT; value: ComparisonValue }) {
  if (typeof value === "boolean") {
    return value ? (
      <span><Check aria-hidden="true" className="mx-auto size-4 text-foreground/60" /><span className="sr-only">{t("plan.comparison.values.common.included")}</span></span>
    ) : (
      <span><Minus aria-hidden="true" className="mx-auto size-4 text-muted-foreground/30" /><span className="sr-only">{t("plan.comparison.values.common.notIncluded")}</span></span>
    );
  }

  if ("text" in value) return <span className="text-muted-foreground">{value.text}</span>;

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

// The table's least width for its columns, so a phone scrolls it rather than squeezing it.
const tableWidths = ["min-w-[360px]", "min-w-[360px]", "min-w-[480px]", "min-w-[600px]", "min-w-[720px]"];

/**
 * The plan comparison: billing.json's display section where it lays one out,
 * with a column for each plan that has a card, else the built-in table. An
 * empty comparison in the section shows none.
 */
export function OnboardingPlanComparison({ display = null, locale, plans, t }: { display?: BillingDisplay | null; locale: string; plans: BillingPlanList; t: OnboardingT }) {
  const { appName } = useBranding();
  if (display?.comparison?.length === 0) return null;
  const cards = planCards(display);
  const columns = cards.map((card) => card.plan);
  const popular = cards.find((card) => card.popular)?.plan ?? null;
  const groups = display?.comparison ? displayGroups(display.comparison, plans, locale, t, appName) : builtInGroups(plans, locale, t);
  const page = display ? pageTextValues(plans, locale, (key, options) => t(key, options ?? {}), appName) : {};
  const freeMinutes = planValues(findPlan(plans, "free_cloud"), plans.currency, locale).minutes;
  return (
    <section id="compare">
      <h2 className="mb-4 text-center font-heading text-2xl font-semibold tracking-tighter md:text-3xl">
        {display?.comparisonTitle ? displayText(display.comparisonTitle, locale, page) : t("plan.compareTitle")}
      </h2>
      <p className="mx-auto mb-12 max-w-lg text-center text-sm leading-relaxed text-muted-foreground">
        {display?.comparisonIntro ? displayText(display.comparisonIntro, locale, page) : t("plan.compareDescription", { minutes: freeMinutes })}
      </p>
      <div className="overflow-x-auto">
        <table className={`w-full ${tableWidths[columns.length] ?? "min-w-[720px]"} text-sm`}>
          <thead>
            <tr className="border-b border-border/60">
              <th className="pr-8 pb-4 text-left text-xs font-medium text-muted-foreground">{t("plan.featureHeader")}</th>
              {columns.map((plan) => <th className="w-[150px] px-4 pb-4 text-center text-xs font-medium text-muted-foreground" key={plan}>{plan === popular ? <span className="inline-flex items-center gap-1.5">{t(`plan.tiers.${plan}.name`)}<span className="rounded-full bg-foreground px-1.5 py-px text-[10px] font-medium text-background">{t("plan.popular")}</span></span> : t(`plan.tiers.${plan}.name`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.id}>
                <tr><td className="pt-8 pb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase" colSpan={columns.length + 1}>{group.title}</td></tr>
                {group.rows.map((row) => (
                  <tr className="border-b border-border/40 last:border-0" key={row.id}>
                    <td className="py-3 pr-8 text-foreground">{row.label}</td>
                    {columns.map((plan) => {
                      const value = row.cells[plan];
                      return <td className="px-4 py-3 text-center" key={plan}>{value === undefined ? null : <ComparisonCell t={t} value={value} />}</td>;
                    })}
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
