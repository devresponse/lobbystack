import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { interfaceLocales, runtimeLocales } from "./locales";
import {
  DEFAULT_MAX_RECEPTIONISTS_PER_BUSINESS,
  DEFAULT_RECEPTIONIST_NAMES,
  ENTRY_LINK_CODE_ALPHABET,
  ENTRY_LINK_CODE_LENGTH,
  RECEPTIONIST_HANDLE_MAX_LENGTH,
  availableReceptionistHandle,
  defaultReceptionistName,
  alphabeticalReceptionistOrder,
  entryLinkCode,
  isAlphabeticalReceptionistOrder,
  entryLinkPath,
  isReceptionistHandle,
  normalizeEntryLinkCode,
  normalizeWebsiteRulePath,
  maxReceptionistsPerBusiness,
  receptionistMayUse,
  websitePageUnderRule,
  websiteRulePagePrefixes,
  receptionistAllowance,
  receptionistHandleFrom,
  receptionistInitials,
  receptionistLocale,
  receptionistPagePath,
} from "./receptionists";

describe("default receptionist names", () => {
  it("names the default receptionist in every language calls or the dashboard use", () => {
    for (const locale of [...runtimeLocales, ...interfaceLocales]) {
      expect(DEFAULT_RECEPTIONIST_NAMES[locale].trim()).not.toBe("");
    }
  });

  it("reads a business's language from a full tag and falls back to English", () => {
    expect(defaultReceptionistName("fr")).toBe("Accueil");
    expect(defaultReceptionistName("pt-BR")).toBe("Recepção");
    expect(defaultReceptionistName("zh_Hans")).toBe("前台");
    expect(defaultReceptionistName(" ES ")).toBe("Recepción");
    expect(defaultReceptionistName("sr")).toBe("Recepcija");
    expect(defaultReceptionistName("nl")).toBe("Front desk");
    expect(defaultReceptionistName("")).toBe("Front desk");
    expect(defaultReceptionistName(null)).toBe("Front desk");
    expect(defaultReceptionistName("constructor")).toBe("Front desk");
  });

  it("matches the names migration 0133 gives existing receptionists", () => {
    const migration = readFileSync(new URL("../../db/migrations/0133_receptionists.sql", import.meta.url), "utf8");
    const names = Object.fromEntries([...migration.matchAll(/WHEN '([a-z]{2})' THEN '([^']+)'/g)].map((match) => [match[1], match[2]]));
    expect(names).toEqual(DEFAULT_RECEPTIONIST_NAMES);
    expect(migration).toContain(`ELSE '${DEFAULT_RECEPTIONIST_NAMES.en}'`);
  });
});

describe("receptionist handles", () => {
  it("accepts lower-case letters and digits joined by single dashes", () => {
    expect(isReceptionistHandle("kitsilano")).toBe(true);
    expect(isReceptionistHandle("store-21")).toBe(true);
    expect(isReceptionistHandle("a")).toBe(true);
    expect(isReceptionistHandle("Kitsilano")).toBe(false);
    expect(isReceptionistHandle("-store")).toBe(false);
    expect(isReceptionistHandle("store-")).toBe(false);
    expect(isReceptionistHandle("store--21")).toBe(false);
    expect(isReceptionistHandle("store_21")).toBe(false);
    expect(isReceptionistHandle("")).toBe(false);
    expect(isReceptionistHandle("a".repeat(RECEPTIONIST_HANDLE_MAX_LENGTH))).toBe(true);
    expect(isReceptionistHandle("a".repeat(RECEPTIONIST_HANDLE_MAX_LENGTH + 1))).toBe(false);
  });

  it("makes a handle from a name", () => {
    expect(receptionistHandleFrom("Kitsilano store")).toBe("kitsilano-store");
    expect(receptionistHandleFrom("  Service & Repairs!  ")).toBe("service-repairs");
    expect(receptionistHandleFrom("Café Crème")).toBe("cafe-creme");
    expect(receptionistHandleFrom("Straße Øst Łódź")).toBe("strasse-ost-lodz");
    expect(receptionistHandleFrom("Recepción")).toBe("recepcion");
    expect(receptionistHandleFrom("受付")).toBe("receptionist");
    expect(receptionistHandleFrom("---")).toBe("receptionist");
    for (const name of ["Kitsilano store", "受付", "Café Crème", "x".repeat(200)]) {
      expect(isReceptionistHandle(receptionistHandleFrom(name))).toBe(true);
    }
  });

  it("makes a handle from a name with long runs of punctuation or spaces", () => {
    expect(receptionistHandleFrom(`${"-".repeat(100_000)}Kitsilano${"\t".repeat(100_000)}store${"!".repeat(100_000)}`)).toBe("kitsilano-store");
    expect(receptionistHandleFrom(`a${"-".repeat(100_000)}`)).toBe("a");
  });

  it("cuts a long name at a dash so the handle fits", () => {
    const handle = receptionistHandleFrom(`${"word ".repeat(20)}end`);
    expect(handle.length).toBeLessThanOrEqual(RECEPTIONIST_HANDLE_MAX_LENGTH);
    expect(handle.endsWith("word")).toBe(true);
    expect(receptionistHandleFrom("a".repeat(90))).toBe("a".repeat(RECEPTIONIST_HANDLE_MAX_LENGTH));
  });

  it("numbers a handle that is taken with the lowest free number", () => {
    expect(availableReceptionistHandle("kitsilano", [])).toBe("kitsilano");
    expect(availableReceptionistHandle("kitsilano", ["kitsilano"])).toBe("kitsilano-2");
    expect(availableReceptionistHandle("kitsilano", ["kitsilano", "kitsilano-2", "kitsilano-3"])).toBe("kitsilano-4");
    expect(availableReceptionistHandle("kitsilano", ["kitsilano", "kitsilano-3"])).toBe("kitsilano-2");
    const long = "a".repeat(RECEPTIONIST_HANDLE_MAX_LENGTH);
    const numbered = availableReceptionistHandle(long, [long]);
    expect(numbered).toBe(`${"a".repeat(RECEPTIONIST_HANDLE_MAX_LENGTH - 2)}-2`);
    expect(isReceptionistHandle(numbered)).toBe(true);
    const dashed = `${"a".repeat(RECEPTIONIST_HANDLE_MAX_LENGTH - 3)}-bb`;
    expect(isReceptionistHandle(availableReceptionistHandle(dashed, [dashed]))).toBe(true);
  });
});

describe("receptionist badges", () => {
  it("shows the first letters of the first two words", () => {
    expect(receptionistInitials("Front desk")).toBe("FD");
    expect(receptionistInitials("kitsilano")).toBe("K");
    expect(receptionistInitials("  Service   and repairs ")).toBe("SA");
    expect(receptionistInitials("受付")).toBe("受");
    expect(receptionistInitials("")).toBe("?");
  });
});

describe("receptionist limits", () => {
  it("reads the deployment cap, 50 unless a whole number from 1 to 500 is set", () => {
    expect(maxReceptionistsPerBusiness({})).toBe(DEFAULT_MAX_RECEPTIONISTS_PER_BUSINESS);
    expect(maxReceptionistsPerBusiness({ MAX_RECEPTIONISTS_PER_BUSINESS: "12" })).toBe(12);
    expect(maxReceptionistsPerBusiness({ MAX_RECEPTIONISTS_PER_BUSINESS: " 200 " })).toBe(200);
    expect(maxReceptionistsPerBusiness({ MAX_RECEPTIONISTS_PER_BUSINESS: "0" })).toBe(50);
    expect(maxReceptionistsPerBusiness({ MAX_RECEPTIONISTS_PER_BUSINESS: "501" })).toBe(50);
    expect(maxReceptionistsPerBusiness({ MAX_RECEPTIONISTS_PER_BUSINESS: "2.5" })).toBe(50);
    expect(maxReceptionistsPerBusiness({ MAX_RECEPTIONISTS_PER_BUSINESS: "ten" })).toBe(50);
  });

  it("allows the plan's number, the cap for a plan without one, never more than the cap", () => {
    expect(receptionistAllowance(1, 50)).toBe(1);
    expect(receptionistAllowance(5, 50)).toBe(5);
    expect(receptionistAllowance(null, 50)).toBe(50);
    expect(receptionistAllowance(undefined, 20)).toBe(20);
    expect(receptionistAllowance(5, 3)).toBe(3);
    expect(receptionistAllowance(0, 50)).toBe(1);
  });
});

describe("receptionist languages", () => {
  it("opens calls in the receptionist's language when it has one calls support", () => {
    expect(receptionistLocale("fr", "en")).toBe("fr");
    expect(receptionistLocale(null, "es")).toBe("es");
    expect(receptionistLocale("sr", "en")).toBe("en");
  });
});

describe("QR link codes", () => {
  it("draws six characters from an alphabet without look-alike letters and digits", () => {
    expect(ENTRY_LINK_CODE_ALPHABET).not.toMatch(/[ilo01]/);
    expect(new Set(ENTRY_LINK_CODE_ALPHABET).size).toBe(ENTRY_LINK_CODE_ALPHABET.length);
    const draws = [0, 30, 5, 12, 29, 1];
    let next = 0;
    const code = entryLinkCode((size) => {
      expect(size).toBe(ENTRY_LINK_CODE_ALPHABET.length);
      return draws[next++]!;
    });
    expect(code).toHaveLength(ENTRY_LINK_CODE_LENGTH);
    expect(code).toBe("a9fp8b");
    expect(normalizeEntryLinkCode(code)).toBe(code);
  });

  it("reads a scanned code trimmed and lower-cased, and refuses what no code can be", () => {
    expect(normalizeEntryLinkCode("  A9FP8B ")).toBe("a9fp8b");
    expect(normalizeEntryLinkCode("abc")).toBeNull();
    expect(normalizeEntryLinkCode("abcdefghjkmnp")).toBeNull();
    expect(normalizeEntryLinkCode("ab-cd")).toBeNull();
    expect(normalizeEntryLinkCode("")).toBeNull();
    expect(normalizeEntryLinkCode(null)).toBeNull();
    expect(normalizeEntryLinkCode(undefined)).toBeNull();
  });

  it("prints a short address on the sign", () => {
    expect(entryLinkPath("a9fp8b")).toBe("/q/a9fp8b");
  });
});

describe("receptionist pages", () => {
  it("gives the default receptionist the business page and the others a page under it", () => {
    expect(receptionistPagePath("acme-dental", null)).toBe("/profile/acme-dental");
    expect(receptionistPagePath("acme-dental", undefined)).toBe("/profile/acme-dental");
    expect(receptionistPagePath("acme-dental", "")).toBe("/profile/acme-dental");
    expect(receptionistPagePath("acme-dental", "billing-desk")).toBe("/profile/acme-dental/billing-desk");
  });

  it("escapes a slug as the business page does", () => {
    expect(receptionistPagePath("café du coin", "front")).toBe("/profile/caf%C3%A9%20du%20coin/front");
  });
});

describe("who may use an article", () => {
  const frontDesk = { id: "front", isDefault: true, knowledgeScope: "all" as const };
  const gastown = { id: "gastown", isDefault: false, knowledgeScope: "audience" as const };
  const limitedDefault = { ...frontDesk, knowledgeScope: "audience" as const };

  it("gives every receptionist the articles for everyone, which every article from before receptionists is", () => {
    for (const receptionist of [frontDesk, gastown, limitedDefault]) {
      expect(receptionistMayUse(receptionist, { audience: "everyone" })).toBe(true);
      expect(receptionistMayUse(receptionist, {})).toBe(true);
    }
  });

  it("gives a chosen article to its receptionists, and to the default one only when it sees every article", () => {
    const chosen = { audience: "chosen" as const, receptionistIds: ["gastown"] };
    expect(receptionistMayUse(gastown, chosen)).toBe(true);
    expect(receptionistMayUse({ ...gastown, id: "kitsilano" }, chosen)).toBe(false);
    expect(receptionistMayUse(frontDesk, chosen)).toBe(true);
    expect(receptionistMayUse(limitedDefault, chosen)).toBe(false);
    // A receptionist told to see every article does.
    expect(receptionistMayUse({ ...gastown, id: "kitsilano", knowledgeScope: "all" }, chosen)).toBe(true);
  });

  it("leaves an article chosen only for archived receptionists to the default one, never to everyone", () => {
    const orphan = { audience: "chosen" as const, receptionistIds: [] };
    expect(receptionistMayUse(limitedDefault, orphan)).toBe(true);
    expect(receptionistMayUse(frontDesk, orphan)).toBe(true);
    expect(receptionistMayUse(gastown, orphan)).toBe(false);
    expect(receptionistMayUse(gastown, { audience: "chosen" })).toBe(false);
  });
});

describe("website rule paths", () => {
  it.each([
    ["/stores/kitsilano/", "/stores/kitsilano/"],
    ["/stores/kitsilano", "/stores/kitsilano/"],
    ["stores/kitsilano", "/stores/kitsilano/"],
    [" /menu ", "/menu/"],
    ["/", "/"],
    ["https://kitsilanocoffee.ca/stores/kitsilano", "/stores/kitsilano/"],
    ["https://kitsilanocoffee.ca", "/"],
  ])("keeps %j as %j", (value, path) => {
    expect(normalizeWebsiteRulePath(value)).toBe(path);
  });

  it.each(["", "  ", "/stores?city=vancouver", "/menu#drinks", "/two words/", "//", "/stores//kitsilano/", "https://kitsilanocoffee.ca/menu?x=1", `/${"a".repeat(300)}/`])("refuses %j", (value) => {
    expect(normalizeWebsiteRulePath(value)).toBeNull();
  });

  it("covers a page at the path and below it, on the same site with or without www", () => {
    const site = "https://kitsilanocoffee.ca/";
    expect(websitePageUnderRule("https://kitsilanocoffee.ca/stores/kitsilano", site, "/stores/kitsilano/")).toBe(true);
    expect(websitePageUnderRule("https://kitsilanocoffee.ca/stores/kitsilano/hours", site, "/stores/kitsilano/")).toBe(true);
    expect(websitePageUnderRule("https://www.kitsilanocoffee.ca/stores/kitsilano/hours", site, "/stores/kitsilano/")).toBe(true);
    expect(websitePageUnderRule("http://kitsilanocoffee.ca/stores/kitsilano", site, "/stores/kitsilano/")).toBe(true);
    expect(websitePageUnderRule("https://kitsilanocoffee.ca/menu", site, "/")).toBe(true);
  });

  it("leaves out a page whose path only starts with the same letters, and other sites", () => {
    const site = "https://kitsilanocoffee.ca/";
    expect(websitePageUnderRule("https://kitsilanocoffee.ca/stores/kitsilano-west", site, "/stores/kitsilano/")).toBe(false);
    expect(websitePageUnderRule("https://kitsilanocoffee.ca/stores", site, "/stores/kitsilano/")).toBe(false);
    expect(websitePageUnderRule("https://othercoffee.ca/stores/kitsilano", site, "/stores/kitsilano/")).toBe(false);
    expect(websitePageUnderRule("https://kitsilanocoffee.ca:8443/stores/kitsilano", site, "/stores/kitsilano/")).toBe(false);
    expect(websitePageUnderRule("not a url", site, "/")).toBe(false);
  });

  it("gives the address prefixes a query narrows the site's pages by", () => {
    expect(websiteRulePagePrefixes("https://www.kitsilanocoffee.ca/", ["/stores/kitsilano/"])).toEqual([
      "http://kitsilanocoffee.ca/stores/kitsilano",
      "http://www.kitsilanocoffee.ca/stores/kitsilano",
      "https://kitsilanocoffee.ca/stores/kitsilano",
      "https://www.kitsilanocoffee.ca/stores/kitsilano",
    ]);
    // The whole site's rule makes the stores' prefixes redundant; a port stays in the site.
    expect(websiteRulePagePrefixes("https://kitsilanocoffee.ca:8443/", ["/stores/kitsilano/", "/"])).toEqual([
      "http://kitsilanocoffee.ca:8443",
      "http://www.kitsilanocoffee.ca:8443",
      "https://kitsilanocoffee.ca:8443",
      "https://www.kitsilanocoffee.ca:8443",
    ]);
    expect(websiteRulePagePrefixes("not a url", ["/"])).toEqual([]);
    expect(websiteRulePagePrefixes("https://kitsilanocoffee.ca/", [])).toEqual([]);
  });

  it("never leaves out a page a rule covers", () => {
    const site = "https://kitsilanocoffee.ca/stores/";
    const rules = ["/", "/stores/", "/stores/kitsilano/", "/menu/drinks/"];
    const pages = ["https://kitsilanocoffee.ca/", "https://kitsilanocoffee.ca/menu", "https://www.kitsilanocoffee.ca/menu/drinks", "http://kitsilanocoffee.ca/menu/drinks/tea",
      "https://kitsilanocoffee.ca/stores", "https://kitsilanocoffee.ca/stores/kitsilano", "https://www.kitsilanocoffee.ca/stores/kitsilano/hours", "https://kitsilanocoffee.ca/stores/kitsilano-west",
      "https://kitsilanocoffee.ca:8443/stores/kitsilano", "https://othercoffee.ca/stores/kitsilano", "https://kitsilanocoffee.ca.example.com/menu"];
    for (const rule of rules) {
      const prefixes = websiteRulePagePrefixes(site, [rule]);
      for (const page of pages) {
        if (websitePageUnderRule(page, site, rule)) expect(prefixes.some((prefix) => page.startsWith(prefix)), `${page} under ${rule}`).toBe(true);
      }
      // Never another site's pages, whatever the path. A host that only starts
      // with the site's (kitsilanocoffee.ca.example.com) can pass the root's
      // prefixes, and websitePageUnderRule turns it away.
      const taken = pages.filter((page) => prefixes.some((prefix) => page.startsWith(prefix)));
      expect(taken.some((page) => new URL(page).hostname === "othercoffee.ca")).toBe(false);
      expect(taken.filter((page) => new URL(page).hostname === "kitsilanocoffee.ca.example.com").every((page) => !websitePageUnderRule(page, site, rule))).toBe(true);
    }
  });
});

describe("the alphabetical order", () => {
  const receptionist = (id: string, name: string, isDefault = false) => ({ id, name, isDefault });
  const front = receptionist("a0", "Front desk", true);
  const store10 = receptionist("b1", "Store 10");
  const store2 = receptionist("b2", "Store 2");
  const eclair = receptionist("b3", "Éclair bakery");
  const kitsilano = receptionist("b4", "kitsilano");

  it("puts the default first, then names as people read them: accents and case aside, numbers by value", () => {
    expect(alphabeticalReceptionistOrder([store10, kitsilano, front, store2, eclair], "fr")).toEqual(["a0", "b3", "b4", "b2", "b1"]);
    expect(alphabeticalReceptionistOrder([store10, store2], "en")).toEqual(["b2", "b1"]);
  });

  it("keeps names alike in the order the list has them", () => {
    expect(alphabeticalReceptionistOrder([receptionist("c2", "Cafe"), receptionist("c1", "café")], "fr")).toEqual(["c2", "c1"]);
    expect(alphabeticalReceptionistOrder([receptionist("c1", "café"), receptionist("c2", "Cafe")], "fr")).toEqual(["c1", "c2"]);
    expect(isAlphabeticalReceptionistOrder([front, receptionist("c2", "Cafe"), receptionist("c1", "café")], "fr")).toBe(true);
  });

  it("reads a language it doesn't know, or none, without failing", () => {
    expect(alphabeticalReceptionistOrder([store10, store2], "not a language")).toEqual(["b2", "b1"]);
    expect(alphabeticalReceptionistOrder([store10, store2], null)).toEqual(["b2", "b1"]);
    expect(alphabeticalReceptionistOrder([store10, store2], "pt_BR")).toEqual(["b2", "b1"]);
  });

  it("knows whether a list goes by name", () => {
    expect(isAlphabeticalReceptionistOrder([front, eclair, kitsilano, store2, store10], "en")).toBe(true);
    expect(isAlphabeticalReceptionistOrder([front, kitsilano, eclair], "en")).toBe(false);
    // The default stays first whatever its name.
    expect(isAlphabeticalReceptionistOrder([eclair, front], "en")).toBe(false);
    // With one receptionist besides the default, or none, there is nothing to order.
    expect(isAlphabeticalReceptionistOrder([front, store10], "en")).toBe(true);
    expect(isAlphabeticalReceptionistOrder([front], "en")).toBe(true);
  });
});
