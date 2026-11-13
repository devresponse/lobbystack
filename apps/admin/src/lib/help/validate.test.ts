import { describe, expect, it } from "vitest";

import type { HelpArticle } from "./types";
import { termPattern, validateHelpArticle } from "./validate";

/** A small page that passes every check, for the cases below to change one part of. */
function page(change: (article: HelpArticle) => void = () => undefined): HelpArticle {
  const article: HelpArticle = {
    slug: "sample",
    title: "Sample",
    section: "general",
    summary: "What the sample screen is for.",
    screenPaths: ["/sample"],
    location: ["Sidebar", "Sample"],
    access: "Anyone on the team.",
    purpose: ["The sample screen lists samples."],
    areas: [{ name: "Sample list", description: "Each sample, newest first." }],
    tasks: [{ title: "Add a sample", steps: ["Select **Add sample**.", "Select **Save**."] }],
  };
  change(article);
  return article;
}

const step = (text: string) => validateHelpArticle(page((article) => { article.tasks = [{ title: "Add a sample", steps: [text, "Select **Save**."] }]; }));

describe("validateHelpArticle", () => {
  it("passes a page in the house format", () => {
    expect(validateHelpArticle(page())).toEqual([]);
  });

  it("lets a page name a button whose label is also a service's name", () => {
    expect(step("Find the event and select **Resend** on its row.")).toEqual([]);
    expect(step("Write to help@resend.com.")).toEqual([expect.stringContaining('names "resend.com"')]);
  });

  it("refuses names from the code, in code marks too, but not an API scope", () => {
    expect(step("The role is shown as `business_admin` in exports.")).toEqual([expect.stringContaining("names something from the code")]);
    expect(step("Ask for `SERVICE_SECRET_KEY`.")).toEqual([expect.stringContaining("names a setting from the code")]);
    expect(step("Give the key the `phone_numbers:manage` scope.")).toEqual([]);
  });

  it("refuses a banned word joined to others by underscores", () => {
    expect(termPattern("Stripe").test("STRIPE_SECRET_KEY")).toBe(true);
    expect(termPattern("Stripe").test("stripe_customer")).toBe(true);
    expect(termPattern("Allo").test("allowed")).toBe(false);
    expect(step("Ask for `stripe_customer`.")).toEqual(expect.arrayContaining([expect.stringContaining('names "Stripe"')]));
  });

  it("refuses dashes typed as hyphens, and a sentence that stops at a colon", () => {
    expect(step("Save it - then close the dialog.")).toEqual([expect.stringContaining("has a dash")]);
    expect(step("Save it -- then close the dialog.")).toEqual([expect.stringContaining("has a dash")]);
    expect(step("Save it — then close the dialog.")).toEqual([expect.stringContaining("has a dash")]);
    expect(step("Choose one of these:")).toEqual([expect.stringContaining("must end with a full stop")]);
    expect(step("Select **Save**")).toEqual([expect.stringContaining("must end with a full stop")]);
  });

  it("lets code marks hold dashes, and a sentence end inside a closing mark", () => {
    expect(step("Run the command with `--business` set.")).toEqual([]);
    expect(step("An empty value shows as `—`.")).toEqual([]);
    expect(step("(This is optional.)")).toEqual([]);
    expect(step("The status changes to \"Ready.\"")).toEqual([]);
    expect(step("You see **We could not save that feedback.**")).toEqual([]);
  });

  it("refuses marks in names and titles, which show as plain text", () => {
    expect(validateHelpArticle(page((article) => { article.tasks = [{ title: "Turn on **Books appointments**", steps: ["Select **Save**."] }]; }))).toEqual([expect.stringContaining("takes no **bold** or `code` marks")]);
    expect(validateHelpArticle(page((article) => { article.areas = [{ name: "`Search`", description: "Each sample, newest first." }]; }))).toEqual([expect.stringContaining("takes no **bold** or `code` marks")]);
  });
});
