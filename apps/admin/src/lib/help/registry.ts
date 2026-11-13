import { HELP_SECTIONS, type HelpArticle, type HelpRequirement, type HelpSection } from "./types";
import type { HelpLocale } from "./locales";
import { createHelpPathMatcher } from "./screen-paths";

// articles:start
import signUp from "./articles/en/sign-up";
import logIn from "./articles/en/log-in";
import resetPassword from "./articles/en/reset-password";
import acceptInvitation from "./articles/en/accept-invitation";
import prospectDemo from "./articles/en/prospect-demo";
import claimDemo from "./articles/en/claim-demo";
import onboardingBrand from "./articles/en/onboarding-brand";
import onboardingBusiness from "./articles/en/onboarding-business";
import onboardingWebsite from "./articles/en/onboarding-website";
import onboardingKnowledge from "./articles/en/onboarding-knowledge";
import onboardingGreeting from "./articles/en/onboarding-greeting";
import onboardingPlan from "./articles/en/onboarding-plan";
import onboardingNumber from "./articles/en/onboarding-number";
import onboardingAttribution from "./articles/en/onboarding-attribution";
import home from "./articles/en/home";
import calls from "./articles/en/calls";
import callDetails from "./articles/en/call-details";
import messages from "./articles/en/messages";
import contacts from "./articles/en/contacts";
import contactDetails from "./articles/en/contact-details";
import appointments from "./articles/en/appointments";
import aiSettings from "./articles/en/ai-settings";
import aiAgents from "./articles/en/ai-agents";
import knowledge from "./articles/en/knowledge";
import questions from "./articles/en/questions";
import services from "./articles/en/services";
import rules from "./articles/en/rules";
import analytics from "./articles/en/analytics";
import integrations from "./articles/en/integrations";
import webhooks from "./articles/en/webhooks";
import websiteWidget from "./articles/en/website-widget";
import usage from "./articles/en/usage";
import plan from "./articles/en/plan";
import team from "./articles/en/team";
import phoneNumber from "./articles/en/phone-number";
import preferences from "./articles/en/preferences";
import notifications from "./articles/en/notifications";
import publicProfile from "./articles/en/public-profile";
import qrCode from "./articles/en/qr-code";
import connectedApps from "./articles/en/connected-apps";
import apiKeys from "./articles/en/api-keys";
import account from "./articles/en/account";
import setupGuide from "./articles/en/setup-guide";
import affiliateProgram from "./articles/en/affiliate-program";
import prospectDemos from "./articles/en/prospect-demos";
import confirmEmailChange from "./articles/en/confirm-email-change";
import cancelAccount from "./articles/en/cancel-account";
import oauthConsent from "./articles/en/oauth-consent";
// articles:end

/** The words around the articles: headings, labels and the index's introduction. */
export type HelpWords = {
  helpCenter: string;
  indexTitle: string;
  indexDescription: string;
  indexIntro: string;
  markdownLink: string;
  markdownIntro: string;
  sections: Record<HelpSection, string>;
  sectionDescriptions: Record<HelpSection, string>;
  breadcrumb: string;
  facts: { location: string; access: string; address: string; page: string };
  headings: { purpose: string; areas: string; fields: string; tasks: string; notes: string; troubleshooting: string; related: string; keywords: string };
  requirements: Record<HelpRequirement, string>;
  allTopics: string;
  pageTitle: (title: string) => string;
};

const englishWords: HelpWords = {
  helpCenter: "Help center",
  indexTitle: "Help center",
  indexDescription: "How each screen of the dashboard works: what it is for, what it shows, the fields it needs and how to do the common jobs there.",
  indexIntro: "Every screen of the dashboard has a page here. Each one explains what the screen is for, what you see on it, which fields it needs and how to do the common jobs, in the same order on every page. The question mark at the top right of a screen opens its page beside the screen.",
  markdownLink: "All help pages in one Markdown file",
  markdownIntro: "Every help page of the dashboard, in one file for AI assistants and knowledge bases. Each page starts with a level-one heading and lists the help page's own address.",
  sections: {
    "getting-started": "Getting started",
    general: "General",
    agent: "Agent",
    manage: "Manage",
    settings: "Settings",
    account: "Your account",
  },
  sectionDescriptions: {
    "getting-started": "Creating an account, signing in, trying a demo and the onboarding steps that set up a new business.",
    general: "The day-to-day screens: home, calls, messages and contacts from the General part of the sidebar, and the appointments list, which you open by its address.",
    agent: "The screens in the Agent part of the sidebar, which decide what your AI receptionist knows, says and does.",
    manage: "Analytics, integrations and the website widget, in the Manage part of the sidebar.",
    settings: "The tabs of the Settings screen: usage, plan, team, phone number, preferences, notifications, public profile, QR code, connected apps and API keys.",
    account: "Your own account, the setup guide, the other screens reached from the sidebar's footer, the top bar or their address, and the pages that open from an email or another app.",
  },
  breadcrumb: "Breadcrumb",
  facts: { location: "Where to find it", access: "Who can use it", address: "Address in the app", page: "Help page" },
  headings: {
    purpose: "What this screen is for",
    areas: "What you see",
    fields: "Fields and settings",
    tasks: "How to",
    notes: "Good to know",
    troubleshooting: "Troubleshooting",
    related: "Related help",
    keywords: "Also known as",
  },
  requirements: { required: "Required", optional: "Optional", conditional: "Sometimes required" },
  allTopics: "All help topics",
  pageTitle: (title) => `${title} | Help`,
};

const englishArticles: readonly HelpArticle[] = [
  // order:start
  signUp,
  logIn,
  resetPassword,
  acceptInvitation,
  prospectDemo,
  claimDemo,
  onboardingBrand,
  onboardingBusiness,
  onboardingWebsite,
  onboardingKnowledge,
  onboardingGreeting,
  onboardingPlan,
  onboardingNumber,
  onboardingAttribution,
  home,
  calls,
  callDetails,
  messages,
  contacts,
  contactDetails,
  appointments,
  aiSettings,
  aiAgents,
  knowledge,
  questions,
  services,
  rules,
  analytics,
  integrations,
  webhooks,
  websiteWidget,
  usage,
  plan,
  team,
  phoneNumber,
  preferences,
  notifications,
  publicProfile,
  qrCode,
  connectedApps,
  apiKeys,
  account,
  setupGuide,
  affiliateProgram,
  prospectDemos,
  confirmEmailChange,
  cancelAccount,
  oauthConsent,
  // order:end
];

const content: Record<HelpLocale, { words: HelpWords; articles: readonly HelpArticle[] }> = {
  en: { words: englishWords, articles: englishArticles },
};

export function helpWords(locale: HelpLocale): HelpWords {
  return content[locale].words;
}

/** Every help page in the language, in the index's order. */
export function helpArticles(locale: HelpLocale): readonly HelpArticle[] {
  return content[locale].articles;
}

export function helpArticle(locale: HelpLocale, slug: string): HelpArticle | undefined {
  return content[locale].articles.find((article) => article.slug === slug);
}

const matchers = new Map<HelpLocale, (pathname: string) => string | null>();

/** The help page that explains an app address, such as /agent/rules or /calls/abc123, or null when no page does. */
export function helpSlugForPath(locale: HelpLocale, pathname: string): string | null {
  let match = matchers.get(locale);
  if (!match) {
    match = createHelpPathMatcher(helpArticles(locale));
    matchers.set(locale, match);
  }
  return match(pathname);
}

/** The index's groups, in order, each with its pages; a group with no pages is left out. */
export function helpSections(locale: HelpLocale): Array<{ section: HelpSection; title: string; description: string; articles: HelpArticle[] }> {
  const words = helpWords(locale);
  return HELP_SECTIONS
    .map((section) => ({ section, title: words.sections[section], description: words.sectionDescriptions[section], articles: helpArticles(locale).filter((article) => article.section === section) }))
    .filter((group) => group.articles.length > 0);
}
