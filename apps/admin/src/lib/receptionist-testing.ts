import type { ReceptionistAllowanceState, ReceptionistChoice, ReceptionistListItem, ReceptionistListPage, ReceptionistView } from "@lobbystack/domain";

// Receptionists as the domain returns them, for route tests that mock the
// domain with typed mocks (vi.fn<Domain["…"]>()). Each builder fills every
// field, so a test that names only a few still hands the route the real
// shape, and a field the domain adds or renames fails the typecheck here
// instead of leaving a stale fixture behind.

const SAVED_AT = new Date("2026-11-01T09:00:00.000Z");

type Named<T> = Pick<T, Extract<keyof T, "id" | "name">> & Partial<T>;

/** A receptionist as dropdowns and pickers list it. */
export function receptionistChoice(fields: Named<ReceptionistChoice>): ReceptionistChoice {
  return { description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "all", ...fields };
}

/** A row of the Receptionists page, with no entry points unless the test names some. */
export function receptionistListItem(fields: Named<ReceptionistListItem>): ReceptionistListItem {
  return { ...receptionistChoice(fields), archivedAt: null, createdAt: SAVED_AT, updatedAt: SAVED_AT, phoneNumbers: 0, widgetKeys: 0, entryLinks: 0, ...fields };
}

/** The first page of the Receptionists page's list, counted from its rows. */
export function receptionistListPage(receptionists: ReceptionistListItem[]): ReceptionistListPage {
  const current = receptionists.filter((row) => !row.archivedAt);
  return {
    receptionists,
    total: receptionists.length,
    page: 1,
    pageSize: 10,
    counts: { active: current.filter((row) => row.status === "active").length, paused: current.filter((row) => row.status === "paused").length, archived: receptionists.length - current.length },
  };
}

/** The plan's allowance as the list returns it: Pro, 2 of its 5 in use, Enterprise through sales. */
export function receptionistAllowanceState(fields: Partial<ReceptionistAllowanceState> = {}): ReceptionistAllowanceState {
  return { plan: "pro", limit: 5, cap: 50, active: 2, current: 2, canAdd: true, upgrade: "sales", ...fields };
}

/** A receptionist with the settings every receptionist shares, as adding or changing one returns it. */
export function receptionistView(fields: Named<ReceptionistView>): ReceptionistView {
  return {
    businessId: "business",
    greeting: "Hi, thanks for reaching out.",
    tone: "friendly",
    bookingPolicy: "Confirm availability before booking.",
    voiceInstructions: null,
    smsInstructions: null,
    chatInstructions: null,
    transferMode: "never",
    transferNumber: null,
    bookingMode: "instant",
    description: "",
    handle: null,
    isDefault: false,
    knowledgeScope: "all",
    listed: true,
    sortOrder: 0,
    locale: null,
    status: "active",
    archivedAt: null,
    createdAt: SAVED_AT,
    updatedAt: SAVED_AT,
    summary: "",
    summarySource: "placeholder",
    summaryFingerprint: null,
    summaryGeneratedAt: null,
    recordingNotice: true,
    appointmentChangePolicy: null,
    ...fields,
  };
}

/** What a route's JSON body holds for a value: dates become ISO strings. */
export function asJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
