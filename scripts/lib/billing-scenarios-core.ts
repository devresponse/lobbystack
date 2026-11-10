// What scripts/billing-scenarios.ts decides without Stripe: its command line,
// which keys it takes, the dates a test clock moves to, and what an overage
// invoice should come to. Kept apart so it's tested without a sandbox.

/** The scenarios, in the order they run: the events check reads what the others made, so it runs last. */
export const SCENARIOS = [
  { name: "checkout", title: "A monthly Starter and a yearly Pro go live, each with its overage subscription anchored on the 1st" },
  { name: "usage", title: "A month's usage past the allowance, a resend and a negative correction: the meters hold it, and the 1st's invoice comes to it to the cent" },
  { name: "upgrade-paid", title: "An upgrade paid with a good card changes the plan at once" },
  { name: "upgrade-declined", title: "An upgrade with a declined card is refused as payment_failed, and the plan stays" },
  { name: "upgrade-3ds", title: "An upgrade with a card that needs 3-D Secure waits on the invoice's page" },
  { name: "downgrade", title: "A downgrade waits for the renewal, and Keep my plan drops a waiting one" },
  { name: "cancel-resume", title: "Cancel and resume, then a cancelled plan ends at its renewal and its overage subscription with its month" },
  { name: "promo-endings", title: "A promo plan ends at the renewal on its tier's price, or cancelled, and a discount comes off" },
  { name: "deletion", title: "Deleting a business ends both subscriptions at once, each with its last invoice" },
  { name: "refund", title: "A refund of the plan's first payment names its invoice" },
  { name: "totals", title: "An event the meters never got shows as a gap, and a correcting event closes it" },
  { name: "pack-plan-end", title: "A monthly plan a prepaid pack replaced ends at once with nothing credited, and the usage on its meters is still billed" },
  { name: "events", title: "Stripe's events of the scenarios above normalize, each to its own business" },
] as const;

export type ScenarioName = (typeof SCENARIOS)[number]["name"];

export type ScenarioOptions = {
  list: boolean;
  help: boolean;
  /** The brand whose billing.json sets the sandbox up; RealInfoBot's when not given. */
  brand: string;
  /** null runs every scenario. */
  only: ScenarioName[] | null;
  /** Leaves the test clocks, and with them the customers and subscriptions, in the sandbox to look at. */
  keep: boolean;
  /** How many scenarios run at once: most of each one's time is a test clock advancing. */
  parallel: number;
  /** Stripe as the merchant of record: each subscription starts from a checkout a person pays. */
  merchantOfRecord: boolean;
};

export class ScenarioUsage extends Error {}

export const SCENARIO_USAGE = [
  "Usage: STRIPE_SCENARIOS_KEY=sk_test_... pnpm billing:scenarios [--only <name>[,<name>...]] [--brand <brand>] [--parallel <n>] [--keep] [--merchant-of-record]",
  "       pnpm billing:scenarios --list",
  "",
  "Runs the Stripe plan's sandbox scenarios against a Stripe sandbox, each on its own test clock, through",
  "LobbyStack's Stripe adapter. Use a sandbox of its own: the run adds the brand's catalog to it, and",
  "customers and subscriptions on test clocks it deletes at the end. With --merchant-of-record, or a brand",
  "whose stripe block sets managedPayments, Stripe is the merchant of record: each subscription starts from",
  "a checkout page the run prints for you to pay with a test card, one scenario at a time.",
  "docs/providers/stripe.md says more.",
].join("\n");

/**
 * The scenarios a merchant of record run makes when none are named: those
 * whose Stripe calls differ from Stripe directly, one checkout to pay each,
 * and the events check. The others run when named, but for those that can't.
 */
export const MERCHANT_OF_RECORD_SCENARIOS: readonly ScenarioName[] = ["usage", "upgrade-paid", "downgrade", "cancel-resume", "totals", "pack-plan-end", "events"];

/** Why a scenario can't run with Stripe as the merchant of record. */
export const MERCHANT_OF_RECORD_CANT: Partial<Record<ScenarioName, string>> = {
  "upgrade-declined": "Stripe lets no API call give a merchant of record subscription a declining card, and a declining card can't pay its checkout.",
};

/**
 * The scenarios a run makes, the events check apart since it reads what the
 * others made, and how many at once: one at a time under merchant of record,
 * where a person pays each checkout. A ScenarioUsage error names a scenario
 * that can't run.
 */
export function scenarioRun(options: Pick<ScenarioOptions, "only" | "parallel">, merchantOfRecord: boolean): { scenarios: Array<Exclude<ScenarioName, "events">>; events: boolean; parallel: number } {
  const named = options.only ?? (merchantOfRecord ? MERCHANT_OF_RECORD_SCENARIOS : SCENARIOS.map((scenario) => scenario.name));
  if (merchantOfRecord) {
    const cant = named.filter((name) => MERCHANT_OF_RECORD_CANT[name]);
    if (cant.length) throw new ScenarioUsage(cant.map((name) => `${name} can't run with Stripe as the merchant of record: ${MERCHANT_OF_RECORD_CANT[name]}`).join(" "));
  }
  return {
    scenarios: named.filter((name): name is Exclude<ScenarioName, "events"> => name !== "events"),
    events: named.includes("events"),
    parallel: merchantOfRecord ? 1 : options.parallel,
  };
}

/** What the run asks of the person paying a merchant of record checkout. */
export function checkoutRequest(input: { scenario: string; url: string; card: "good" | "3ds" }): string {
  const card = input.card === "3ds" ? "test card 4000 0027 6000 3184, and approve on the bank's test page" : "test card 4242 4242 4242 4242";
  return `Pay the ${input.scenario} checkout with ${card}, any future date, any CVC and any address, within 20 minutes: ${input.url}`;
}

/** The command line, or a ScenarioUsage error that says what's wrong. */
export function parseScenarioArgs(argv: readonly string[]): ScenarioOptions {
  const options: ScenarioOptions = { list: false, help: false, brand: "realinfobot", only: null, keep: false, parallel: 4, merchantOfRecord: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      const given = inline ?? argv[(index += 1)];
      if (given === undefined || given === "" || given.startsWith("--")) throw new ScenarioUsage(`${flag} needs a value.`);
      return given;
    };
    if (flag === "--list") options.list = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--keep") options.keep = true;
    else if (flag === "--merchant-of-record") options.merchantOfRecord = true;
    else if (flag === "--brand") {
      options.brand = value();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(options.brand)) throw new ScenarioUsage("--brand names a folder under brands/, such as realinfobot.");
    } else if (flag === "--parallel") {
      const count = Number(value());
      if (!Number.isInteger(count) || count < 1 || count > 8) throw new ScenarioUsage("--parallel is a whole number from 1 to 8.");
      options.parallel = count;
    } else if (flag === "--only") {
      const names = value().split(",").map((name) => name.trim()).filter(Boolean);
      const unknown = names.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name));
      if (unknown.length) throw new ScenarioUsage(`No scenario is called ${unknown.join(", ")}. --list lists them.`);
      options.only = [...new Set(names)] as ScenarioName[];
    } else throw new ScenarioUsage(`Unknown option ${arg}.`);
  }
  return options;
}

/**
 * The key the scenarios run with: a test key only, since they make customers,
 * subscriptions and payments, and move test clocks, which only a sandbox has.
 * A secret key, or a restricted key with every permission the run uses.
 */
export function scenarioKeyProblem(key: string | undefined): string | null {
  const trimmed = key?.trim() ?? "";
  if (!trimmed) return "Set STRIPE_SCENARIOS_KEY to a test key of the sandbox the scenarios run in (sk_test_...). It's never printed.";
  if (/^[rs]k_live_/.test(trimmed)) return "STRIPE_SCENARIOS_KEY is a live key. The scenarios make payments and move test clocks, so they run in a sandbox, with a test key.";
  if (!/^[rs]k_test_[A-Za-z0-9]+$/.test(trimmed)) return "STRIPE_SCENARIOS_KEY isn't a Stripe test key (sk_test_ or rk_test_).";
  return null;
}

/**
 * Why the sandbox can't be the scenarios' own, or null. A run makes customers
 * and payments, and archives the prices the other selling mode sold, so it
 * never runs where a deployment bills. pnpm billing apply gives a deployment's
 * sandbox a webhook endpoint and an event destination, and the scenarios make
 * neither, so any endpoint or destination at all is taken as a deployment's.
 */
export function scenarioSandboxProblem(snapshot: { webhooks: ReadonlyArray<{ url: string }>; eventDestinations: ReadonlyArray<{ url: string | null; type: string }> }): string | null {
  const targets = [...snapshot.webhooks.map((endpoint) => endpoint.url), ...snapshot.eventDestinations.map((destination) => destination.url ?? destination.type)];
  if (!targets.length) return null;
  const where = [...new Set(targets.map(hostOf))].join(", ");
  return `This sandbox sends events to ${where}, so it isn't the scenarios' own: a run makes customers and payments in it and archives prices a deployment may sell. Run them in a sandbox of their own, or delete this one's webhook endpoints and event destinations if nothing uses them.`;
}

function hostOf(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

/** A text with every Stripe key in it, whole or in part as Stripe's errors show one, replaced. */
export function redactKeys(text: string): string {
  return text.replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9*]+/g, "‹key›");
}

/** The same output, with every key redacted from what it says. */
export function redactingOutput<T extends { out(text: string): void; err(text: string): void }>(io: T): T {
  const out = io.out.bind(io);
  const err = io.err.bind(io);
  return { ...io, out: (text: string) => out(redactKeys(text)), err: (text: string) => err(redactKeys(text)) };
}

/** The first of the month after a moment, at 00:00 UTC: when an overage subscription renews. */
export function nextFirstOfMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** The first of a moment's own month, at 00:00 UTC. */
export function firstOfMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * What an overage invoice should come to before tax, in whole cents: the
 * prices sent to the money meters, a dollar a unit, which Stripe sums and
 * rounds once on the line.
 */
export function expectedOverageCents(sentCents: readonly number[]): number {
  return Math.round(sentCents.reduce((sum, cents) => sum + cents, 0));
}

/** Within a ten-thousandth of a cent, the precision priceUsage keeps. */
export const sameCents = (a: number, b: number) => Math.abs(a - b) < 0.0001;

/**
 * The stripe block a run uses when the brand's file has none yet: the answers
 * to the Stripe plan's decisions, as the brand's own block will hold them.
 */
export const SCENARIO_STRIPE_BLOCK = {
  upgrade: "invoice",
  downgrade: "next_period",
  portalPlanChanges: false,
  portalCancel: false,
  tax: { behavior: "exclusive", code: "txcd_10103001" },
  usageGraceHours: 1,
  overage: "separate",
  managedPayments: false,
} as const;

/** The settings a merchant of record run gives the stripe block: Managed Payments, and overage on the plan's checkout. */
export const MERCHANT_OF_RECORD_BLOCK = { managedPayments: true, overage: "checkout" } as const;

/** Runs work over items, at most `limit` at once, keeping their order in the answer. */
export async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}
