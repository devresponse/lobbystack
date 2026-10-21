import { CONTACT_PASSCODE_DEFAULT_LENGTH, CONTACT_PASSCODE_MAX_LENGTH, CONTACT_PASSCODE_MIN_LENGTH, CONTACT_PASSCODES_MAX_PER_REQUEST, formatPublicProfileAddress, isUuid, weekdays, type ApiHoursWindow, type ApiPublicProfileUpdate } from "@lobbystack/shared";

import { createClient } from "./client";
import { stringValue, type Command, type Group } from "./command";
import { readConfig, resolveConnection, writeConfig } from "./config";
import { CliError, exitCodes } from "./errors";
import { defaultSleep, operationCommand, showRecord, waitUntilDone, type Column, type OperationSpec, type Row } from "./operations";
import { formatTable, print } from "./output";
import { readUploadFile, uploadKnowledgeFile } from "./upload";
import { userAgent } from "./version";
import { checkoutWait, claimWait, sourceWait } from "./waits";

// The command groups. Most commands are specs for operationCommand; the few
// that need more than one call, or a file, are written out below.

type Entry = OperationSpec | ((path: string) => Command);

function group(name: string, summary: string, entries: Record<string, Entry>): [string, Group] {
  const commands = Object.fromEntries(Object.entries(entries).map(([command, entry]) => {
    const path = `${name} ${command}`;
    return [command, typeof entry === "function" ? entry(path) : operationCommand(path, entry)];
  }));
  return [name, { summary, commands }];
}

const columns = (...keys: string[]): Column[] => keys.map((key) => ({ key, label: key.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase()) }));

const businessUse = (path: string): Command => ({
  summary: "Make a business the one this profile's commands act on.",
  usage: `lobbystack ${path} <business_id> [--profile <name>]`,
  operations: ["getBusiness"],
  async run({ io, output, values, positionals, configPath }) {
    const [id, ...extra] = positionals;
    if (!id || extra.length) throw new CliError(`Usage: lobbystack ${path} <business_id> [--profile <name>]`);
    if (!isUuid(id)) throw new CliError("<business_id> must be a business id, a UUID such as 5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f.");
    const connection = resolveConnection(await readConfig(configPath), io.env, { profile: stringValue(values, "profile"), business: id });
    const profile = connection.profile;
    if (profile === null) throw new CliError("LOBBYSTACK_URL and LOBBYSTACK_API_KEY are in use, so there's no profile to save the business in. Set LOBBYSTACK_BUSINESS instead.");
    // Checks the key can act on it before saving it.
    const business = (await createClient({ url: connection.url, key: connection.key, business: id, userAgent, ...(io.fetch ? { fetch: io.fetch } : {}) }).call("getBusiness")).data;
    // Read again: another command may have changed the file during the call.
    const config = await readConfig(configPath);
    const saved = config.profiles[profile];
    if (!saved || saved.url !== connection.url || saved.key !== connection.key) throw new CliError(`The ${profile} profile changed while this ran. Run the command again.`);
    config.profiles[profile] = { ...saved, business: id };
    await writeConfig(configPath, config);
    print(output, business, () => `The ${profile} profile now acts on ${business.name} (${id}).`);
  },
});

const windowPattern = /^((?:[01]\d|2[0-3]):[0-5]\d|24:00)-((?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;

function hoursTable(hours: readonly ApiHoursWindow[]): string {
  return formatTable(weekdays.map((day) => ({ day, hours: hours.filter((window) => window.day === day).map((window) => `${window.open}-${window.close}`).join(", ") || "closed" })), columns("day", "hours"));
}

const hoursGet = (path: string): Command => ({
  summary: "Show the opening hours, day by day.",
  usage: `lobbystack ${path}`,
  operations: ["getBusiness"],
  async run({ output, connect }) {
    const { client } = await connect();
    const { hours } = (await client.call("getBusiness")).data;
    print(output, hours, () => hoursTable(hours));
  },
});

const hoursSet = (path: string): Command => {
  const usage = `lobbystack ${path} [--monday 09:00-17:00] [--saturday 10:00-14:00] [--sunday closed] ...`;
  return {
    summary: "Change the opening hours of the days named. The other days keep theirs.",
    usage,
    options: Object.fromEntries(weekdays.map((day) => [day, { type: "string", placeholder: "<hours>", description: day === "sunday" ? "HH:MM-HH:MM, two windows separated by a comma for a break, or closed." : "" }])),
    operations: ["getBusiness", "updateBusiness"],
    async run({ output, values, positionals, connect }) {
      if (positionals.length) throw new CliError(`Usage: ${usage}`);
      const changed = new Map<string, ApiHoursWindow[]>();
      for (const day of weekdays) {
        const raw = stringValue(values, day);
        if (raw === undefined) continue;
        changed.set(day, raw.trim() === "closed" ? [] : raw.split(",").map((part) => {
          const match = windowPattern.exec(part.trim());
          if (!match) throw new CliError(`--${day} takes HH:MM-HH:MM, such as 09:00-17:00, two of them separated by a comma, or closed.`);
          return { day, open: match[1]!, close: match[2]! };
        }));
      }
      if (!changed.size) throw new CliError(`Name at least one day.\nUsage: ${usage}`);
      const { client } = await connect();
      // The API replaces the whole week, so the days left out are sent as they are.
      const current = (await client.call("getBusiness")).data.hours;
      const hours = weekdays.flatMap((day) => changed.get(day) ?? current.filter((window) => window.day === day));
      const business = (await client.call("updateBusiness", { body: { hours } })).data;
      print(output, business.hours, () => hoursTable(business.hours));
    },
  };
};

const knowledgeUpload = (path: string): Command => {
  const usage = `lobbystack ${path} <file> [--title <title>] [--tags <tag,tag>] [--wait]`;
  return {
    summary: "Upload a document the receptionist can answer from: PDF, Word, text, Markdown or an image, up to 10 MB.",
    usage,
    options: {
      title: { type: "string", placeholder: "<title>", description: "Defaults to the file's name." },
      tags: { type: "string", multiple: true, placeholder: "<tag>", description: "Repeat the flag or separate with commas." },
      wait: { type: "boolean", description: "Wait until it's read, checking every few seconds. A failure exits with 1." },
    },
    operations: ["createKnowledgeUpload", "completeKnowledgeUpload", "getKnowledgeSource"],
    async run(context) {
      const { io, output, values, positionals } = context;
      const [path, ...extra] = positionals;
      if (!path || extra.length) throw new CliError(`Usage: ${usage}`);
      const file = await readUploadFile(path);
      const { client, connection } = await context.connect();
      const tags = values.tags === undefined ? undefined : (Array.isArray(values.tags) ? values.tags : [String(values.tags)]).flatMap((tag) => tag.split(",")).map((tag) => tag.trim()).filter(Boolean);
      let source = await uploadKnowledgeFile(client, { baseUrl: connection.url, fetch: io.fetch ?? fetch, file, title: typeof values.title === "string" ? values.title : undefined, tags });
      if (values.wait === true) source = await waitUntilDone(client, sourceWait, source, io.sleep ?? defaultSleep);
      print(output, source, () => showRecord(source));
      const failure = values.wait === true ? sourceWait.failed(source) : undefined;
      if (failure) throw new CliError(failure, exitCodes.failed);
    },
  };
};

function generatedPinsText(path: string, given: readonly Row[], remaining: number): string {
  const pins = given.length ? `${formatTable(given, columns("id", "name", "phone", "new_passcode"))}\n\nThese PINs aren't shown again, so give each customer theirs.` : "No contact got a new PIN.";
  const rest = remaining === 0 ? "Every contact with a phone number has a PIN." : `${remaining === 1 ? "1 contact with a phone number still has" : `${remaining} contacts with a phone number still have`} no PIN. To give them one, run lobbystack ${path} --all.`;
  return `${pins}\n\n${rest}`;
}

const contactsGeneratePins = (path: string): Command => {
  const usage = `lobbystack ${path} [<contact_id>...] [--length <digits>] [--all]`;
  return {
    summary: "Give contacts a random keypad PIN, and show each PIN this once.",
    usage,
    arguments: [{ name: "contact_id...", description: `Contacts to give a new PIN, replacing any PIN they have. Leave them out for contacts that have a phone number and no PIN, ${CONTACT_PASSCODES_MAX_PER_REQUEST} at a time.` }],
    options: {
      length: { type: "string", placeholder: "<digits>", description: `Digits in each PIN, ${CONTACT_PASSCODE_MIN_LENGTH} to ${CONTACT_PASSCODE_MAX_LENGTH}. Defaults to ${CONTACT_PASSCODE_DEFAULT_LENGTH}.` },
      all: { type: "boolean", description: "Keep going until every contact with a phone number has a PIN." },
    },
    notes: "Only a hash of each PIN is kept, so this is the only time the PINs are shown. Keep the output safe until every customer has theirs.",
    operations: ["generateContactPasscodes"],
    async run({ output, values, positionals, connect }) {
      const digits = stringValue(values, "length");
      const length = digits === undefined ? undefined : Number(digits);
      if (length !== undefined && (!/^\d+$/.test(digits!) || length < CONTACT_PASSCODE_MIN_LENGTH || length > CONTACT_PASSCODE_MAX_LENGTH)) throw new CliError(`--length takes ${CONTACT_PASSCODE_MIN_LENGTH} to ${CONTACT_PASSCODE_MAX_LENGTH}.`);
      if (values.all === true && positionals.length) throw new CliError(`--all gives a PIN to the contacts without one, so it takes no contact ids.\nUsage: ${usage}`);
      const body = { ...(positionals.length ? { contact_ids: positionals } : {}), ...(length !== undefined ? { length } : {}) };
      const { client } = await connect();
      const given: Row[] = [];
      let remaining = 0;
      const show = () => print(output, { contacts: given, remaining }, () => generatedPinsText(path, given, remaining));
      try {
        for (;;) {
          const batch = (await client.call("generateContactPasscodes", { body })).data;
          given.push(...batch.contacts);
          remaining = batch.remaining;
          // A request that gave no PIN stops the loop rather than repeating it.
          if (values.all !== true || remaining === 0 || !batch.contacts.length) break;
        }
      } catch (error) {
        // The PINs given so far exist nowhere else, so they're shown before the error.
        if (given.length) show();
        throw error;
      }
      show();
    },
  };
};

function teamTables(data: Row): string {
  const members = data.members as Row[];
  const invitations = data.invitations as Row[];
  return [`Members\n${formatTable(members, columns("id", "name", "email", "role", "joined_at"))}`, `Invitations\n${formatTable(invitations, columns("id", "email", "role", "status", "transfers_ownership", "expires_at"))}`].join("\n\n");
}

function onboardingTable(data: Row): string {
  const checklist = data.checklist as Row[];
  const missing = data.missing as string[];
  return `${formatTable(checklist.map((item) => ({ ...item, required: item.required ? "yes" : "" })), columns("id", "status", "required"))}\n\nStage: ${String(data.stage)}. ${data.complete ? "Onboarding is complete." : missing.length ? `Still needed to finish: ${missing.join(", ")}.` : "Ready to finish with lobbystack onboarding complete."}`;
}

/** "4900 cad monthly" as "49.00 CAD a month". */
function priceText(price: Row): string {
  return `${(Number(price.cents) / 100).toFixed(2)} ${String(price.currency).toUpperCase()} ${price.period === "annual" ? "a year" : "a month"}`;
}

/** Every plan the deployment holds with its live prices, and whether the applied file is the deployed one. */
function catalogTables(data: Row): string {
  const plans = (data.plans as Row[]).map((plan) => ({ ...plan, prices: (plan.prices as Row[]).filter((price) => price.retired_at === null).map(priceText).join(", ") }));
  const run = data.last_run as Row | null;
  if (!run) return `Nothing applied yet for ${String(data.brand)}. See what applying its file would change with lobbystack billing catalog-preview ${String(data.brand)} --billing-file @brands/${String(data.brand)}/billing.json.`;
  const matches = data.matches_code ? "the file the running code was built with" : data.code_hash ? "not the file the running code was built with: apply the deployed one" : "and the running code has no billing.json for this brand";
  return `${formatTable(plans, columns("code", "tier", "status", "access", "sold", "prices"))}\n\nApplied ${String(run.started_at)} from file ${String(data.hash).slice(0, 12)}, ${matches}.`;
}

/** What an apply changed, or with a preview would change, and anything that stops it. */
function catalogChanges(data: Row): string {
  const changes = (data.changes as Row[]).map((change) => ({ ...change, fields: Object.keys(change.fields as Row).join(", "), warns: [change.lowers_allowance ? "lowers an allowance" : "", change.raises_price ? "raises a price" : ""].filter(Boolean).join(", ") }));
  const blocked = data.blocked_by as Row[];
  const table = changes.length ? `${formatTable(changes, columns("action", "table", "key", "fields", "warns"))}\n\n` : "";
  const count = `${changes.length} ${changes.length === 1 ? "change" : "changes"}`;
  if (data.status === "preview") {
    if (blocked.length) return `${table}Applying would be refused, and nothing would change:\n${blocked.map((refusal) => `  ${String(refusal.code)} (${String(refusal.path)}): ${String(refusal.message)}`).join("\n")}`;
    return `${table}${changes.length ? `Applying would make these ${count}` : "The tables already match this file"}. Nothing was written. Apply it with lobbystack billing catalog-apply ${String(data.brand)} --billing-file <the same file>${data.prev_hash ? ` --replaces-hash ${String(data.prev_hash)}` : ""}.`;
  }
  return `${table}${data.status === "unchanged" ? "The tables already matched this file" : `Applied ${count}`} in run ${String(data.id)}.`;
}

/** The page's settings, with the address on one line. */
function publicProfileText(data: Row): string {
  const address = data.address as Row;
  const line = formatPublicProfileAddress({ line1: address.line1 as string | null, line2: address.line2 as string | null, city: address.city as string | null, region: address.region as string | null, postalCode: address.postal_code as string | null, countryCode: address.country_code as string | null });
  const record = showRecord({ ...data, address: line || null });
  return data.published ? record : `${record}\n\nThe page isn't published, so its address answers 404. Publish it with lobbystack public-profile publish.`;
}

const addressFlags = { line1: "line1", line2: "line2", city: "city", region: "region", "postal-code": "postal_code", "country-code": "country_code" } as const;

const publicProfileAddress = (path: string): Command => {
  const usage = `lobbystack ${path} [--line1 <text>] [--line2 <text>] [--city <text>] [--region <text>] [--postal-code <text>] [--country-code <code>]`;
  return {
    summary: "Change the parts of the page's address named. The other parts keep theirs.",
    usage,
    options: {
      line1: { type: "string", placeholder: "<text>", description: "The street address." },
      line2: { type: "string", placeholder: "<text>", description: "More of it, such as a suite." },
      city: { type: "string", placeholder: "<text>" },
      region: { type: "string", placeholder: "<text>", description: "Province or state." },
      "postal-code": { type: "string", placeholder: "<text>" },
      "country-code": { type: "string", placeholder: "<code>", description: "Two letters, such as CA." },
    },
    notes: "null removes a part.",
    operations: ["updatePublicProfile"],
    async run({ output, values, positionals, connect }) {
      if (positionals.length) throw new CliError(`Usage: ${usage}`);
      const address = Object.fromEntries(Object.entries(addressFlags).flatMap(([flag, field]) => {
        const raw = stringValue(values, flag);
        return raw === undefined ? [] : [[field, raw === "null" ? null : raw]];
      })) as NonNullable<ApiPublicProfileUpdate["address"]>;
      if (!Object.keys(address).length) throw new CliError(`Name at least one part of the address.\nUsage: ${usage}`);
      const { client } = await connect();
      const profile = (await client.call("updatePublicProfile", { body: { address } })).data;
      print(output, profile, () => publicProfileText(profile));
    },
  };
};

export const groups: Record<string, Group> = Object.fromEntries([
  group("business", "Create, list and pick businesses, and change their details.", {
    list: { operation: "listBusinesses", columns: columns("id", "name", "timezone", "onboarding_stage", "created_at") },
    create: { operation: "createBusiness", args: ["name"] },
    get: { operation: "getBusiness" },
    update: { operation: "updateBusiness" },
    use: businessUse,
  }),
  group("users", "Make dashboard accounts for owners who have none yet, with a platform key.", {
    create: { operation: "createUser", args: ["email"] },
  }),
  group("hours", "See and change the opening hours.", { get: hoursGet, set: hoursSet }),
  group("receptionist", "See and change how the receptionist greets, answers and books.", {
    get: { operation: "getReceptionist" },
    set: { operation: "updateReceptionist", files: ["summary", "booking_policy", "voice_instructions", "sms_instructions", "chat_instructions"] },
  }),
  group("services", "The services customers can book.", {
    list: { operation: "listServices", columns: columns("id", "name", "duration_minutes", "active", "staff_ids") },
    add: { operation: "createService", args: ["name"] },
    update: { operation: "updateService" },
    remove: { operation: "deleteService" },
  }),
  group("staff", "The people who take appointments.", { list: { operation: "listStaff", columns: columns("id", "name", "active", "timezone", "service_ids") } }),
  group("rules", "The instructions the receptionist follows.", {
    list: { operation: "listRules", columns: columns("id", "title", "active", "updated_at") },
    add: { operation: "createRule", files: ["content"] },
    update: { operation: "updateRule", files: ["content"] },
    remove: { operation: "deleteRule" },
    reorder: { operation: "reorderRules", args: ["...rule_ids"], columns: columns("id", "title", "active") },
  }),
  group("knowledge", "What the receptionist answers from: text, FAQs, websites and documents.", {
    list: { operation: "listKnowledgeEntries", columns: columns("id", "type", "title", "active", "updated_at") },
    get: { operation: "getKnowledgeEntry" },
    "add-text": { operation: "createKnowledgeEntry", summary: "Add text the receptionist can answer from.", fixed: { type: "text" }, files: ["content"] },
    "add-faq": { operation: "createKnowledgeEntry", summary: "Add a question and its answer.", fixed: { type: "faq" }, files: ["answer"] },
    update: { operation: "updateKnowledgeEntry", files: ["content"] },
    remove: { operation: "deleteKnowledgeEntry" },
    "add-website": { operation: "createKnowledgeSource", args: ["url"], fixed: { type: "website" }, wait: sourceWait },
    upload: knowledgeUpload,
    sources: { operation: "listKnowledgeSources", columns: columns("id", "type", "title", "status", "active", "url") },
    source: { operation: "getKnowledgeSource" },
    "source-update": { operation: "updateKnowledgeSource" },
    "source-remove": { operation: "deleteKnowledgeSource" },
    expand: { operation: "expandKnowledgeSource", wait: sourceWait },
    retry: { operation: "retryKnowledgeSource", wait: sourceWait },
    cancel: { operation: "cancelKnowledgeSource" },
  }),
  group("billing", "The plan, its checkout and the spending cap, and with an operator key the deployment's billing catalog.", {
    status: { operation: "getBilling" },
    cap: { operation: "updateBilling", args: ["spending_cap_cents"] },
    checkout: { operation: "createCheckout", wait: checkoutWait, show: (data) => data.checkout_url ? `Send this page to whoever pays: ${String(data.checkout_url)}` : `${showRecord(data)}\n\nThe page isn't ready yet. Wait for it with --wait, or check with lobbystack billing checkout-status ${String(data.id)}.` },
    "checkout-status": { operation: "getCheckout" },
    "managed-plan": { operation: "setManagedPlan", fixed: { plan: "enterprise" } },
    "end-managed-plan": { operation: "endManagedPlan" },
    catalog: { operation: "getBillingCatalog", show: catalogTables },
    "catalog-preview": { operation: "applyBillingCatalog", summary: "Show what applying a billing.json would change. Nothing is written.", args: ["brand"], fixed: { dry_run: true }, show: catalogChanges },
    "catalog-apply": { operation: "applyBillingCatalog", args: ["brand"], fixed: { dry_run: false }, show: catalogChanges },
    "catalog-runs": { operation: "listBillingCatalogRuns", columns: columns("id", "kind", "status", "brand", "hash", "started_at") },
  }),
  group("numbers", "Find, claim, replace and release phone numbers.", {
    list: { operation: "listPhoneNumbers", columns: columns("id", "phone_number", "status", "release_scheduled_at") },
    search: { operation: "searchPhoneNumbers", columns: columns("phone_number", "locality", "region", "kind", "expires_at", "offer_token") },
    claim: { operation: "createPhoneNumberClaim", args: ["offer_token"], wait: claimWait },
    "claim-status": { operation: "getPhoneNumberClaim" },
    replace: { operation: "replacePhoneNumber", args: ["offer_token"], wait: claimWait },
    release: { operation: "releasePhoneNumber" },
  }),
  group("onboarding", "How far setup is, and finishing it.", {
    status: { operation: "getOnboarding", show: onboardingTable },
    skip: { operation: "updateOnboarding", args: ["...skip_steps"], show: onboardingTable },
    complete: { operation: "completeOnboarding", show: onboardingTable },
  }),
  group("team", "Who can sign in to the business, and handing it over.", {
    list: { operation: "getTeam", show: teamTables },
    invite: { operation: "createTeamInvitation", args: ["email"] },
    revoke: { operation: "revokeTeamInvitation" },
    role: { operation: "updateTeamMember", args: ["role"] },
    remove: { operation: "removeTeamMember" },
    "transfer-owner": { operation: "createClaimLink", args: ["email"], show: (data) => `Sent ${String((data.invitation as Row).email)} a link to claim the business. You can also send it yourself:\n${String(data.url)}` },
  }),
  group("widget", "The chat widget on the business's websites.", {
    list: { operation: "listWidgetKeys", columns: columns("id", "label", "status", "key", "allowed_origins", "last_used_at") },
    create: { operation: "createWidgetKey", show: (data) => `Key: ${String(data.key)}\n\nPaste this into the website's HTML:\n${String(data.embed_snippet)}` },
    update: { operation: "updateWidgetKey" },
  }),
  group("public-profile", "The business's public page at /profile/<slug>, and publishing it.", {
    get: { operation: "getPublicProfile", show: publicProfileText },
    set: { operation: "updatePublicProfile", files: ["description"], show: publicProfileText },
    address: publicProfileAddress,
    publish: { operation: "updatePublicProfile", summary: "Publish the page, so anyone can open it.", fixed: { published: true }, show: (data) => `Published. Anyone can open ${String(data.url)}.` },
    unpublish: { operation: "updatePublicProfile", summary: "Take the page down. Its address answers 404 until it's published again.", fixed: { published: false }, show: (data) => `Taken down. ${String(data.url)} answers 404 until the page is published again.` },
  }),
  group("calendar", "Google Calendar connections.", {
    connect: { operation: "createCalendarConnectLink", show: (data) => `Send this link to whoever owns the Google Calendar. It works until ${String(data.expires_at)}:\n${String(data.url)}` },
    list: { operation: "listCalendarConnections", columns: columns("id", "account_id", "calendar_id", "staff_id", "status", "last_synced_at") },
    calendars: { operation: "listAccountCalendars", columns: columns("id", "name", "primary", "writable", "selected") },
    set: { operation: "updateCalendarConnection" },
    disconnect: { operation: "deleteCalendarConnection" },
  }),
  group("alerts", "The alerts the key's account gets about the business.", {
    get: { operation: "getNotificationPreferences" },
    set: { operation: "updateNotificationPreferences" },
  }),
  group("webhooks", "Endpoints that receive events.", {
    list: { operation: "listWebhooks", columns: columns("id", "url", "status", "events") },
    add: { operation: "createWebhook", args: ["url"] },
    get: { operation: "getWebhook" },
    update: { operation: "updateWebhook" },
    remove: { operation: "deleteWebhook" },
    test: { operation: "testWebhook" },
  }),
  group("contacts", "The business's contacts.", {
    list: { operation: "listContacts", columns: columns("id", "name", "phone", "email", "created_at") },
    get: { operation: "getContact" },
    add: { operation: "createContact" },
    update: { operation: "updateContact" },
    "set-pins": { operation: "setContactPasscodes", columns: columns("id", "name", "phone", "passcode") },
    "generate-pins": contactsGeneratePins,
  }),
  group("appointments", "Appointments and open times.", {
    list: { operation: "listAppointments", columns: columns("id", "starts_at", "status", "service_name", "staff_name", "contact_name") },
    get: { operation: "getAppointment" },
    availability: { operation: "getAvailability", columns: columns("starts_at", "ends_at") },
    book: { operation: "createAppointment" },
    cancel: { operation: "cancelAppointment" },
    reschedule: { operation: "rescheduleAppointment" },
  }),
  group("calls", "Calls the receptionist took.", {
    list: { operation: "listCalls", columns: columns("id", "started_at", "caller_phone", "outcome", "duration_seconds") },
    get: { operation: "getCall" },
    // AI debug traces (ADR 0009): what the models were given and did on a call or website chat.
    traces: { operation: "listAiTraces", columns: columns("id", "created_at", "kind", "channel", "direct_answer", "failed") },
    trace: { operation: "getAiTrace" },
  }),
  group("messages", "Messages the receptionist took for the team.", {
    list: { operation: "listMessages", columns: columns("id", "created_at", "status", "urgency", "caller_name", "title") },
  }),
]);
