// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../public/locales/en/receptionists.json";
import { receptionistChoicesQueryKey, receptionistMatches, receptionistQuery, type ReceptionistOption } from "./receptionist-choices";
import { ReceptionistFilter } from "./receptionist-filter";
import { ReceptionistNames } from "./receptionist-names";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
  usePathname: () => "/calls",
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "receptionists", interpolation: { escapeValue: false }, resources: { en: { receptionists: en } } });
});
beforeEach(() => {
  navigation.params = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true });
const KITSILANO = receptionist("00000000-0000-4000-8000-0000000000a2", "Kitsilano clinic");
const BILLING = receptionist("00000000-0000-4000-8000-0000000000a3", "Billing");
const GASTOWN = receptionist("00000000-0000-4000-8000-0000000000a4", "Gastown clinic");

function renderFilter(receptionists: ReceptionistOption[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists });
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><ReceptionistFilter businessId="business" /></QueryClientProvider></I18nextProvider>);
}

describe("the receptionist filter", () => {
  it("is hidden while the business has one receptionist", () => {
    renderFilter([FRONT_DESK]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the receptionist the address names, even when only one is left, so it can be cleared", () => {
    navigation.params = new URLSearchParams(`receptionist=${KITSILANO.id.toUpperCase()}`);
    renderFilter([FRONT_DESK]);
    expect(screen.getByRole("combobox", { name: "Receptionist A receptionist that's no longer listed" })).toBeTruthy();
  });

  it("reads All receptionists from an address without one, or with something that isn't one", () => {
    navigation.params = new URLSearchParams("receptionist=kitsilano");
    renderFilter([FRONT_DESK, KITSILANO]);
    expect(screen.getByRole("combobox", { name: "Receptionist All receptionists" })).toBeTruthy();
  });

  it("keeps the receptionist chosen in the address, with the other filters, back on the first page", async () => {
    navigation.params = new URLSearchParams("status=missed&page=3");
    renderFilter([FRONT_DESK, KITSILANO, BILLING]);
    await userEvent.click(screen.getByRole("combobox", { name: "Receptionist All receptionists" }));
    await userEvent.click(screen.getByRole("option", { name: /Kitsilano clinic/ }));
    expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(`/calls?status=missed&receptionist=${KITSILANO.id}`, { scroll: false });
  });

  it("drops it from the address for All receptionists", async () => {
    navigation.params = new URLSearchParams(`receptionist=${KITSILANO.id}`);
    renderFilter([FRONT_DESK, KITSILANO, BILLING]);
    await userEvent.click(screen.getByRole("combobox", { name: "Receptionist Kitsilano clinic" }));
    await userEvent.click(screen.getByRole("option", { name: "All receptionists" }));
    expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("/calls", { scroll: false });
  });
});

describe("who something is for, in a table cell", () => {
  const all = [FRONT_DESK, KITSILANO, BILLING, GASTOWN];
  const cell = (everyone: boolean, receptionistIds: string[]) => {
    render(<I18nextProvider i18n={i18n}><ReceptionistNames everyone={everyone} receptionistIds={receptionistIds} receptionists={all} /></I18nextProvider>);
    return document.body.textContent;
  };

  it("says Everyone for an article for everyone", () => {
    expect(cell(true, [KITSILANO.id])).toBe("Everyone");
  });

  it("names up to 2 receptionists, in the business's order, and counts the rest", () => {
    expect(cell(false, [KITSILANO.id])).toBe("Kitsilano clinic");
    cleanup();
    expect(cell(false, [GASTOWN.id, KITSILANO.id])).toBe("Kitsilano clinic, Gastown clinic");
    cleanup();
    expect(cell(false, [GASTOWN.id, BILLING.id, KITSILANO.id])).toBe("Kitsilano clinic, Billing +1");
    expect(screen.getByTitle("Kitsilano clinic, Billing, Gastown clinic")).toBeTruthy();
  });

  it("leaves archived receptionists out, and says the default answers when none is left", () => {
    expect(cell(false, ["00000000-0000-4000-8000-0000000000ee", BILLING.id])).toBe("Billing");
    cleanup();
    expect(cell(false, ["00000000-0000-4000-8000-0000000000ee"])).toBe("Default receptionist only");
  });
});

describe("helpers", () => {
  it("search receptionists by name or what each helps with, ignoring case and accents", () => {
    const spanish = receptionist("x", "Recepción", { description: "Atención en español" });
    expect(receptionistMatches(spanish, "  RECEPCION ")).toBe(true);
    expect(receptionistMatches(spanish, "espanol")).toBe(true);
    expect(receptionistMatches(spanish, "billing")).toBe(false);
    expect(receptionistMatches(spanish, "")).toBe(true);
  });

  it("add a receptionist to an API address only when one is chosen", () => {
    expect(receptionistQuery(null)).toBe("");
    expect(receptionistQuery(KITSILANO.id)).toBe(`&receptionist=${KITSILANO.id}`);
  });
});
