// polar-setup.mjs: sets up Polar billing for LobbyStack through Polar's API.
//
// In the Polar organization that owns the token, it creates:
//   1. Three meters that add up the usage the worker sends.
//   2. Six Credits benefits holding the monthly plans' allowances.
//   3. Four products (Starter and Pro, monthly and annual), each with a fixed
//      price and three metered prices. The monthly products get the credits.
//   4. The webhook to the dashboard, with every subscription.* and order.* event.
//   5. Plan changes and usage in the customer portal.
// Prices use the organization's default currency, or the one --currency names, with
// the same amounts as the dashboard (30 for Starter, and so on). A --currency other
// than the organization's default also becomes its default.
// Then it prints the values Railway needs, in the format railway-vars.mjs reads.
//
// Run it with Node 18 or later:
//   node polar-setup.mjs --sandbox     test mode, organization on sandbox.polar.sh
//   node polar-setup.mjs --live        real payments, organization on polar.sh
// Options:
//   --dry-run              show what it would do and change nothing
//   --currency <code>      the prices' currency, such as cad or usd
//   --webhook-url <url>    defaults to https://demo.alloplace.com/api/webhooks/polar
//   --railway-file <path>  also save the Railway values to this new file, for
//                          railway-vars.mjs to set in Railway
//   --yes                  skip the confirmation question
//
// It asks for an organization access token, or reads POLAR_SETUP_TOKEN, and
// never saves or prints it. The token needs these scopes: meters:write,
// benefits:write, products:write, webhooks:write and organizations:write.
// Running it again is safe: it reuses what it finds and creates what's missing.
//
// Plan numbers come from billingPlanCatalog and event names from
// billingMeterEventNames in packages/shared/src/billing.ts (fork main d18f916).

import fs from "node:fs";
import readline from "node:readline";

const METERS = [
  { key: "voice", name: "Voice minutes", event: "billing.voice_minutes", noun: "voice minutes" },
  { key: "sms", name: "Alert SMS segments", event: "billing.alert_sms_segments", noun: "alert SMS segments" },
  { key: "transfers", name: "Call transfers", event: "billing.outbound_call_attempts", noun: "call transfers" },
];

// Allowance included each month, and the overage price per unit in cents.
const PLANS = [
  {
    key: "STARTER",
    label: "Starter",
    monthlyCents: 3700,
    annualCents: 37000,
    included: { voice: 150, sms: 50, transfers: 20 },
    overageCents: { voice: 20, sms: 2, transfers: 2 },
  },
  {
    key: "PRO",
    label: "Pro",
    monthlyCents: 8700,
    annualCents: 87000,
    included: { voice: 500, sms: 200, transfers: 100 },
    overageCents: { voice: 18, sms: 2, transfers: 2 },
  },
];

// Annual plans get no credits: the worker already sends them only the overage.
const PRODUCTS = PLANS.flatMap((plan) => [
  { plan, name: `${plan.label} monthly`, interval: "month", amountCents: plan.monthlyCents, withCredits: true, variable: `POLAR_${plan.key}_MONTHLY_PRODUCT_ID` },
  { plan, name: `${plan.label} annual`, interval: "year", amountCents: plan.annualCents, withCredits: false, variable: `POLAR_${plan.key}_ANNUAL_PRODUCT_ID` },
]);

const WEBHOOK_EVENTS = [
  "subscription.created",
  "subscription.active",
  "subscription.updated",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
  "subscription.cycled",
  "subscription.paused",
  "subscription.resumed",
  "subscription.migrated",
  "order.created",
  "order.updated",
  "order.paid",
  "order.refunded",
];

const SCOPES = "meters:write, benefits:write, products:write, webhooks:write and organizations:write";

class PolarError extends Error {
  constructor(method, path, status, body) {
    super(`Polar answered ${status} to ${method} ${path.split("?")[0]}: ${describeBody(body)}`);
    this.status = status;
  }
}

const options = parseArgs(process.argv.slice(2));
const mode = options.live ? "live" : "sandbox";
const baseUrl = options.live ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";
let token = "";
let currency = "usd";

main().catch((error) => {
  console.error(`\nStopped: ${error.message}`);
  if (error.status === 401) console.error(`Polar didn't accept the token. A sandbox token works only with --sandbox, and a live one only with --live.`);
  if (error.status === 403) console.error(`The token may be missing a scope. It needs ${SCOPES}.`);
  console.error("Fix that and run the same command again; it picks up where it stopped.");
  process.exitCode = 1;
});

async function main() {
  if (typeof fetch !== "function") throw new Error("this script needs Node 18 or later");
  token = (process.env.POLAR_SETUP_TOKEN ?? "").trim() || (await ask("Polar setup token (typing is hidden): ", { hidden: true }));
  if (!token) throw new Error("no token given");
  if (!token.startsWith("polar_oat_")) console.warn("That doesn't look like an organization access token (those start with polar_oat_). Trying anyway.");

  const organizations = await listAll("/v1/organizations/");
  if (organizations.length !== 1) throw new Error(`the token reaches ${organizations.length} organizations; use an organization access token`);
  const organization = organizations[0];
  const defaultCurrency = String(organization.default_presentment_currency ?? "usd").toLowerCase();
  currency = options.currency ?? defaultCurrency;
  console.log(`Polar ${mode} organization: ${organization.name} (${organization.id})`);
  console.log(`Webhook address: ${options.webhookUrl}`);
  if (currency === defaultCurrency) {
    console.log(`Prices in ${currency.toUpperCase()}, the organization's default currency: ${money(3000)} for Starter monthly, and so on.`);
  } else {
    console.log(`Prices in ${currency.toUpperCase()}: ${money(3000)} for Starter monthly, and so on. The organization's default currency is ${defaultCurrency.toUpperCase()}, so this also makes ${currency.toUpperCase()} the default.`);
  }
  if (options.dryRun) {
    console.log("Dry run: nothing will change.");
  } else if (!options.yes) {
    const answer = await ask(`Set up LobbyStack billing in this ${mode} organization? Type yes to continue: `);
    if (answer.toLowerCase() !== "yes") {
      console.log("Nothing changed.");
      return;
    }
  }

  if (currency !== defaultCurrency) await changeDefaultCurrency(organization, defaultCurrency);
  const meterIds = await setUpMeters();
  const creditIds = await setUpCredits(meterIds);
  const productIds = await setUpProducts(meterIds, creditIds);
  const endpoint = await setUpWebhook();
  await setUpCustomerPortal(organization);

  if (options.dryRun) {
    console.log("\nDry run finished. Run the same command without --dry-run to make these changes.");
    return;
  }
  // The format railway-vars.mjs reads: each [...] line names the Railway services that
  // get the variables under it, and ? makes railway-vars.mjs ask for the value.
  const railway = [
    "[lobbystack-admin, worker]",
    `POLAR_API_BASE_URL=${baseUrl}`,
    `POLAR_ORGANIZATION_ID=${organization.id}`,
    ...PRODUCTS.map((spec) => `${spec.variable}=${productIds[spec.variable]}`),
    "POLAR_ACCESS_TOKEN=?",
    "",
    "[lobbystack-admin]",
    `POLAR_WEBHOOK_SECRET=${endpoint.secret ?? "?"}`,
  ].join("\n");
  console.log("\nPolar is set up. These are the Railway variables: the ones under [lobbystack-admin, worker] go on both services, and the one under [lobbystack-admin] on the admin only.\n");
  console.log(railway);
  console.log("\nPOLAR_ACCESS_TOKEN is LobbyStack's own Polar token, with checkouts:write, customer_sessions:write and events:write, not this setup token. railway-vars.mjs asks for it.");
  if (!endpoint.secret) console.log("Polar didn't send the webhook secret, so railway-vars.mjs asks for that too. Copy it from the webhook's page in Polar.");
  if (options.railwayFile) {
    const shown = /\s/.test(options.railwayFile) ? `"${options.railwayFile}"` : options.railwayFile;
    const header = [
      `# Railway variables from polar-setup.mjs (Polar ${mode}), ${new Date().toISOString().slice(0, 10)}.`,
      `# Set them with: node railway-vars.mjs ${shown}`,
      "# Each [...] line names Railway services; change it if yours are named differently.",
      "# POLAR_ACCESS_TOKEN=? makes railway-vars.mjs ask for LobbyStack's own Polar token",
      "# (checkouts:write, customer_sessions:write and events:write), not the setup token.",
      "",
    ].join("\n");
    fs.writeFileSync(options.railwayFile, `${header}${railway}\n`, { flag: "wx", mode: 0o600 });
    console.log(`\nSaved them to ${options.railwayFile}. To set them in Railway, run: node railway-vars.mjs ${shown}`);
    if (endpoint.secret) console.log("The file holds the webhook secret, so delete it once Railway has the values.");
  }
  console.log("\nYou can revoke the setup token now, in Polar under Settings > Developers.");
}

// Polar refuses a product without a price in the default currency, and refuses to
// change the default while an active product has no price in the new currency.
async function changeDefaultCurrency(organization, previous) {
  console.log("\nCurrency");
  const code = currency.toUpperCase();
  const products = await listAll("/v1/products/", { is_archived: "false" });
  const blocking = products.filter((product) => !(product.prices ?? []).some((price) => !price.is_archived && inCurrency(price) && (price.source ?? "catalog") === "catalog"));
  if (blocking.length) {
    throw new Error(`Polar won't make ${code} the default while these products have no ${code} price: ${quoteNames(blocking)}. Archive them or give them a ${code} price in Polar, or leave out --currency to use ${previous.toUpperCase()}.`);
  }
  await write("PATCH", `/v1/organizations/${organization.id}`, { default_presentment_currency: currency }, `make ${code} the default currency instead of ${previous.toUpperCase()}`);
}

async function setUpMeters() {
  console.log("\nMeters");
  const meters = await listAll("/v1/meters/", { is_archived: "false" });
  const meterIds = {};
  for (const spec of METERS) {
    const matches = meters.filter((meter) => clausesOf(meter.filter).some((clause) => clause.property === "name" && clause.value === spec.event));
    if (matches.length > 1) throw new Error(`${matches.length} meters count ${spec.event} (${quoteNames(matches)}). Archive all but one in Polar.`);
    const [meter] = matches;
    if (meter) {
      const clauses = clausesOf(meter.filter);
      if (clauses.length !== 1 || clauses[0].operator !== "eq") throw new Error(`meter "${meter.name}" filters on something other than Name equals ${spec.event}. Make that its only condition in Polar, or archive it.`);
      if (!sumsQuantity(meter.aggregation)) throw new Error(`meter "${meter.name}" doesn't use Sum of quantity. Archive it in Polar so this script can create it again.`);
      console.log(`  Reusing "${meter.name}" for ${spec.event}`);
      meterIds[spec.key] = meter.id;
      continue;
    }
    for (const other of meters.filter((candidate) => candidate.name === spec.name)) {
      console.warn(`  Note: a meter named "${other.name}" exists but doesn't count ${spec.event}. Check its event name in Polar, or archive it.`);
    }
    const created = await write("POST", "/v1/meters/", {
      name: spec.name,
      filter: { conjunction: "and", clauses: [{ property: "name", operator: "eq", value: spec.event }] },
      aggregation: { func: "sum", property: "quantity" },
    }, `create meter "${spec.name}" (Sum of quantity where Name equals ${spec.event})`);
    meterIds[spec.key] = created?.id ?? `new-${spec.key}-meter`;
  }
  return meterIds;
}

async function setUpCredits(meterIds) {
  console.log("\nCredits for the monthly plans");
  const benefits = await listAll("/v1/benefits/", { type: "meter_credit" });
  const creditIds = {};
  for (const plan of PLANS) {
    for (const spec of METERS) {
      const units = plan.included[spec.key];
      const existing = benefits.find((benefit) => benefit.properties?.meter_id === meterIds[spec.key] && benefit.properties?.units === units);
      if (existing) {
        if (existing.properties.rollover) console.warn(`  Note: "${existing.description}" rolls unused credits over. Untick that in Polar: the dashboard resets the allowance each month.`);
        console.log(`  Reusing "${existing.description}" for ${plan.label}`);
        creditIds[`${plan.key}.${spec.key}`] = existing.id;
        continue;
      }
      const description = `${units} ${spec.noun} a month`;
      const created = await write("POST", "/v1/benefits/", {
        type: "meter_credit",
        description,
        properties: { units, rollover: false, meter_id: meterIds[spec.key] },
      }, `create credits "${description}" for ${plan.label} monthly`);
      creditIds[`${plan.key}.${spec.key}`] = created?.id ?? `new-${plan.key}-${spec.key}-credits`;
    }
  }
  return creditIds;
}

async function setUpProducts(meterIds, creditIds) {
  console.log("\nProducts");
  const products = await listAll("/v1/products/", { is_archived: "false" });
  const productIds = {};
  for (const spec of PRODUCTS) {
    const matches = products.filter((product) => product.name === spec.name);
    if (matches.length > 1) throw new Error(`${matches.length} products are named "${spec.name}". Archive all but one in Polar.`);
    let product = matches[0];
    if (product) {
      const problems = productProblems(product, spec, meterIds);
      if (problems.length) throw new Error(`product "${spec.name}" already exists but ${problems.join(", ")}. Fix it or archive it in Polar.`);
      console.log(`  Reusing "${spec.name}"`);
    } else {
      product = await write("POST", "/v1/products/", {
        name: spec.name,
        recurring_interval: spec.interval,
        prices: [
          { amount_type: "fixed", price_amount: spec.amountCents, price_currency: currency },
          ...METERS.map((meter) => ({ amount_type: "metered_unit", meter_id: meterIds[meter.key], unit_amount: String(spec.plan.overageCents[meter.key]), price_currency: currency })),
        ],
      }, `create product "${spec.name}" (${describePrices(spec)})`);
    }
    const productId = product?.id ?? `new-product-${spec.variable}`;
    productIds[spec.variable] = productId;

    const attached = (product?.benefits ?? []).map((benefit) => benefit.id);
    if (spec.withCredits) {
      const missing = METERS.map((meter) => creditIds[`${spec.plan.key}.${meter.key}`]).filter((id) => !attached.includes(id));
      if (missing.length) await write("POST", `/v1/products/${productId}/benefits`, { benefits: [...attached, ...missing] }, `attach ${missing.length} credits to "${spec.name}"`);
    } else {
      const credits = (product?.benefits ?? []).filter((benefit) => benefit.type === "meter_credit");
      if (credits.length) console.warn(`  Note: "${spec.name}" has credits attached (${credits.map((benefit) => `"${benefit.description}"`).join(", ")}). Remove them in Polar: annual plans already report only the overage, so the allowance would come off twice.`);
    }
  }
  return productIds;
}

async function setUpWebhook() {
  console.log("\nWebhook");
  const endpoints = await listAll("/v1/webhooks/endpoints");
  const sameUrl = endpoints.filter((endpoint) => trimSlash(endpoint.url) === trimSlash(options.webhookUrl));
  if (sameUrl.length > 1) throw new Error(`${sameUrl.length} webhooks point at ${options.webhookUrl}. Delete all but one in Polar.`);
  let endpoint = sameUrl[0];
  if (!endpoint) {
    endpoint = await write("POST", "/v1/webhooks/endpoints", {
      url: options.webhookUrl,
      name: "LobbyStack",
      format: "raw",
      events: WEBHOOK_EVENTS,
    }, `create the webhook to ${options.webhookUrl}`);
    return endpoint ?? {};
  }
  if (endpoint.format !== "raw") throw new Error(`the webhook to ${endpoint.url} uses the ${endpoint.format} format, and LobbyStack needs Raw. Change it in Polar.`);
  const missing = WEBHOOK_EVENTS.filter((event) => !endpoint.events?.includes(event));
  if (missing.length) {
    const updated = await write("PATCH", `/v1/webhooks/endpoints/${endpoint.id}`, { events: [...(endpoint.events ?? []), ...missing] }, `add ${missing.join(", ")} to the webhook`);
    endpoint = updated ?? endpoint;
  } else {
    console.log(`  Reusing the webhook to ${endpoint.url}`);
  }
  if (endpoint.enabled === false) console.warn("  Note: this webhook is turned off in Polar. Turn it on there, or payments won't reach the dashboard.");
  return endpoint;
}

async function setUpCustomerPortal(organization) {
  console.log("\nCustomer portal");
  const portal = organization.customer_portal_settings ?? {};
  const subscription = portal.subscription ?? {};
  if (subscription.update_plan === true && portal.usage?.show === true) {
    console.log("  Plan changes and usage are already on");
  } else {
    await write("PATCH", `/v1/organizations/${organization.id}`, {
      customer_portal_settings: {
        ...portal,
        usage: { ...(portal.usage ?? {}), show: true },
        subscription: { update_seats: true, ...subscription, update_plan: true },
      },
    }, "turn on plan changes and usage in the customer portal");
  }
  if (organization.subscription_settings?.allow_multiple_subscriptions) {
    console.warn("  Note: Allow multiple subscriptions is on (Settings > Subscriptions in Polar). Turn it off so a business can't pay for Starter and Pro at once.");
  }
}

function productProblems(product, spec, meterIds) {
  const problems = [];
  if (product.recurring_interval !== spec.interval || (product.recurring_interval_count ?? 1) !== 1) {
    problems.push(`it doesn't bill once a ${spec.interval}`);
  }
  const active = (product.prices ?? []).filter((price) => !price.is_archived);
  const otherCurrencies = [...new Set(active.filter((price) => !inCurrency(price)).map((price) => String(price.price_currency).toUpperCase()))];
  if (otherCurrencies.length) problems.push(`it has prices in ${otherCurrencies.join(", ")}`);
  const prices = active.filter(inCurrency);
  const fixed = prices.filter((price) => price.amount_type === "fixed");
  if (fixed.length !== 1 || fixed[0].price_amount !== spec.amountCents) {
    problems.push(`its fixed price isn't ${money(spec.amountCents)}`);
  }
  for (const meter of METERS) {
    const metered = prices.filter((price) => price.amount_type === "metered_unit" && price.meter_id === meterIds[meter.key]);
    if (metered.length !== 1 || Number(metered[0].unit_amount) !== spec.plan.overageCents[meter.key]) {
      problems.push(`its ${meter.name} price isn't ${money(spec.plan.overageCents[meter.key])} each`);
    }
  }
  const ourMeters = Object.values(meterIds);
  const others = prices.filter((price) => price.amount_type !== "fixed" && !(price.amount_type === "metered_unit" && ourMeters.includes(price.meter_id)));
  if (others.length) problems.push(`it has ${others.length} other price${others.length === 1 ? "" : "s"}`);
  return problems;
}

function describePrices(spec) {
  const metered = METERS.map((meter) => `${meter.name} ${money(spec.plan.overageCents[meter.key])}`).join(", ");
  return `${money(spec.amountCents)} a ${spec.interval}, then ${metered}`;
}

async function write(method, path, body, description) {
  if (options.dryRun) {
    console.log(`  Would ${description}`);
    return null;
  }
  const result = await api(method, path, body);
  console.log(`  Done: ${description}`);
  return result;
}

async function listAll(path, filters = {}) {
  const items = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ ...filters, page: String(page), limit: "100" });
    const data = await api("GET", `${path}?${query}`);
    items.push(...(data?.items ?? []));
    if (page >= (data?.pagination?.max_page ?? 1)) return items;
  }
}

async function api(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // A write that timed out may have landed, so only reads are retried here.
      if (method === "GET" && attempt < 4) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`couldn't reach ${baseUrl} (${error.cause?.code ?? error.message})`);
    }
    // Polar answers 429 before doing anything, so any request can be retried then.
    if ((response.status === 429 || (method === "GET" && response.status >= 500)) && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    const text = await response.text();
    const data = text ? parseJson(text) : null;
    if (!response.ok) throw new PolarError(method, path, response.status, data ?? text);
    return data;
  }
}

function parseArgs(argv) {
  const parsed = { live: false, sandbox: false, dryRun: false, yes: false, currency: undefined, webhookUrl: "https://demo.alloplace.com/api/webhooks/polar" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--live") parsed.live = true;
    else if (arg === "--sandbox") parsed.sandbox = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg === "--currency") parsed.currency = (argv[++index] ?? "").toLowerCase();
    else if (arg.startsWith("--currency=")) parsed.currency = arg.slice("--currency=".length).toLowerCase();
    else if (arg === "--webhook-url") parsed.webhookUrl = argv[++index] ?? "";
    else if (arg.startsWith("--webhook-url=")) parsed.webhookUrl = arg.slice("--webhook-url=".length);
    else if (arg === "--railway-file") parsed.railwayFile = argv[++index] ?? "";
    else if (arg.startsWith("--railway-file=")) parsed.railwayFile = arg.slice("--railway-file=".length);
    else usage(`Unknown option ${arg}.`);
  }
  if (parsed.live === parsed.sandbox) usage("Choose --sandbox or --live.");
  if (parsed.currency !== undefined && !/^[a-z]{3}$/.test(parsed.currency)) usage("--currency must be a three-letter code such as cad or usd.");
  if (!/^https:\/\/[^/\s]+\/\S+$/.test(parsed.webhookUrl)) usage("--webhook-url must be a full https:// address.");
  if (parsed.railwayFile === "" || parsed.railwayFile?.startsWith("--")) usage("--railway-file needs a file name.");
  if (parsed.railwayFile && fs.existsSync(parsed.railwayFile)) usage(`${parsed.railwayFile} already exists. Name a new file, or delete that one first.`);
  return parsed;
}

function usage(problem) {
  console.error(`${problem}\n\nUsage: node polar-setup.mjs --sandbox|--live [--currency <code>] [--dry-run] [--webhook-url <url>] [--railway-file <path>] [--yes]`);
  process.exit(2);
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const terminal = process.stdin.isTTY === true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\nNothing changed.\n");
      process.exit(130);
    });
    let muted = false;
    if (hidden && terminal) {
      // Show the question, then hide what's typed; a redraw keeps only the question.
      rl._writeToOutput = (text) => {
        if (!muted) process.stdout.write(text);
        else if (text.startsWith(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (muted) process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = hidden && terminal;
  });
}

function clausesOf(filter) {
  if (!filter) return [];
  if (Array.isArray(filter.clauses)) return filter.clauses.flatMap(clausesOf);
  return [filter];
}

function inCurrency(price) {
  return String(price.price_currency ?? "").toLowerCase() === currency;
}

function sumsQuantity(aggregation) {
  return aggregation?.func === "sum" && (aggregation.property === "quantity" || aggregation.property === "metadata.quantity");
}

function describeBody(body) {
  if (body && Array.isArray(body.detail)) {
    return body.detail.map((item) => `${(item.loc ?? []).join(".")}: ${item.msg}`).join("; ");
  }
  if (body && typeof body.detail === "string") return body.detail;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function quoteNames(items) {
  return items.map((item) => `"${item.name}"`).join(", ");
}

function money(cents) {
  return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

function trimSlash(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
