import { describe, expect, it } from "vitest";

import { MAX_ARTICLES_PER_AUDIENCE_CHANGE } from "@lobbystack/shared";

import { readKnowledgeAudienceChange, readKnowledgeAudienceChoice, readWebsiteRuleInput } from "./knowledgeAudience";

const gastown = "00000000-0000-4000-8000-0000000000a1";
const kitsilano = "00000000-0000-4000-8000-0000000000a2";
const menu = "00000000-0000-4000-8000-0000000000d1";
const hours = "00000000-0000-4000-8000-0000000000e1";

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal.");
}

describe("reading who one article is for", () => {
  it("reads everyone, or the receptionists chosen, each once", () => {
    expect(readKnowledgeAudienceChoice({ audience: "everyone", receptionistIds: [gastown] })).toEqual({ audience: "everyone" });
    expect(readKnowledgeAudienceChoice({ audience: "chosen", receptionistIds: [gastown, kitsilano, gastown] })).toEqual({ audience: "chosen", receptionistIds: [gastown, kitsilano] });
  });

  it("reads ids sent in capitals in lower case, as the database keeps them", () => {
    expect(readKnowledgeAudienceChoice({ audience: "chosen", receptionistIds: [gastown.toUpperCase(), gastown, kitsilano.toUpperCase()] })).toEqual({ audience: "chosen", receptionistIds: [gastown, kitsilano] });
    expect(readKnowledgeAudienceChange({ documentIds: [menu.toUpperCase()], snippetIds: [hours.toUpperCase(), hours], audience: "chosen", mode: "add", receptionistIds: [gastown.toUpperCase()] }))
      .toEqual({ documentIds: [menu], snippetIds: [hours], audience: "chosen", mode: "add", receptionistIds: [gastown] });
    expect(readWebsiteRuleInput({ rootDocumentId: menu.toUpperCase(), pathPrefix: "/stores/", receptionistId: kitsilano.toUpperCase() })).toEqual({ rootDocumentId: menu, pathPrefix: "/stores/", receptionistId: kitsilano });
  });

  it("refuses an unknown audience, chosen without receptionists, and ids that aren't ids", () => {
    for (const body of [null, [], "everyone", { audience: "some" }, { audience: "chosen" }, { audience: "chosen", receptionistIds: [] }, { audience: "chosen", receptionistIds: ["gastown"] }, { audience: "chosen", receptionistIds: gastown }]) {
      expect(refusal(() => readKnowledgeAudienceChoice(body))).toMatchObject({ status: 400, code: "invalid_audience" });
    }
  });
});

describe("reading a change to many articles", () => {
  it("reads the articles selected and the change: everyone, or add, remove or replace receptionists", () => {
    expect(readKnowledgeAudienceChange({ documentIds: [menu, menu], snippetIds: [hours], audience: "everyone" })).toEqual({ documentIds: [menu], snippetIds: [hours], audience: "everyone" });
    for (const mode of ["add", "remove", "replace"] as const) {
      expect(readKnowledgeAudienceChange({ documentIds: [menu], audience: "chosen", mode, receptionistIds: [gastown] })).toEqual({ documentIds: [menu], snippetIds: [], audience: "chosen", mode, receptionistIds: [gastown] });
    }
  });

  it("needs one article at least and at most 500 in all", () => {
    expect(refusal(() => readKnowledgeAudienceChange({ documentIds: [], snippetIds: [], audience: "everyone" }))).toMatchObject({ status: 400, code: "invalid_articles" });
    const ids = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${prefix}${String(index).padStart(12 - prefix.length, "0")}`);
    expect(readKnowledgeAudienceChange({ documentIds: ids(300, "d"), snippetIds: ids(200, "e"), audience: "everyone" })).toMatchObject({ audience: "everyone" });
    expect(refusal(() => readKnowledgeAudienceChange({ documentIds: ids(300, "d"), snippetIds: ids(201, "e"), audience: "everyone" }))).toMatchObject({ status: 400, code: "invalid_articles" });
    expect(refusal(() => readKnowledgeAudienceChange({ documentIds: ids(MAX_ARTICLES_PER_AUDIENCE_CHANGE + 1, "d"), audience: "everyone" }))).toMatchObject({ status: 400, code: "invalid_articles" });
    expect(refusal(() => readKnowledgeAudienceChange({ documentIds: ["menu"], audience: "everyone" }))).toMatchObject({ status: 400, code: "invalid_articles" });
  });

  it("refuses an unknown audience or mode, and chosen without receptionists", () => {
    for (const body of [null, { documentIds: [menu] }, { documentIds: [menu], audience: "some" }, { documentIds: [menu], audience: "chosen", receptionistIds: [gastown] }, { documentIds: [menu], audience: "chosen", mode: "merge", receptionistIds: [gastown] }, { documentIds: [menu], audience: "chosen", mode: "add", receptionistIds: [] }]) {
      expect(refusal(() => readKnowledgeAudienceChange(body))).toMatchObject({ status: 400, code: "invalid_audience" });
    }
  });
});

describe("reading a website rule", () => {
  it("reads a site, a path on it written any usual way, and a receptionist", () => {
    for (const pathPrefix of ["/stores/kitsilano/", "stores/kitsilano", " /stores/kitsilano ", "https://kitsilanocoffee.ca/stores/kitsilano"]) {
      expect(readWebsiteRuleInput({ rootDocumentId: menu, pathPrefix, receptionistId: kitsilano })).toEqual({ rootDocumentId: menu, pathPrefix: "/stores/kitsilano/", receptionistId: kitsilano });
    }
  });

  it("refuses a missing site or receptionist and a path with a query, a fragment or spaces", () => {
    for (const body of [null, { pathPrefix: "/stores/", receptionistId: kitsilano }, { rootDocumentId: menu, pathPrefix: "/stores/" }, { rootDocumentId: "site", pathPrefix: "/stores/", receptionistId: kitsilano }]) {
      expect(refusal(() => readWebsiteRuleInput(body))).toMatchObject({ status: 400, code: "invalid_website_rule" });
    }
    for (const pathPrefix of ["", "   ", "/stores/?page=2", "/stores/#top", "/our stores/", "//stores/", 42, `/${"a".repeat(300)}/`]) {
      expect(refusal(() => readWebsiteRuleInput({ rootDocumentId: menu, pathPrefix, receptionistId: kitsilano }))).toMatchObject({ status: 400, code: "invalid_website_rule" });
    }
  });
});
