import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HelpArticle } from "../apps/admin/src/lib/help/types";
import { helpKbDrift, helpKbFolders, helpKbOutputs, readHelpKbConfig, screenGuide, screenGuides, SECTION_MAX_CHARACTERS, splitSection, withScreensBlock } from "./help-kb";

/** The knowledge base's passages: chunkText in packages/domain cuts at each heading, then at this many characters. */
const PASSAGE_CHARACTERS = 1_800;
const sectionsOf = (markdown: string) => markdown.split(/(?<=\s)(?=#{1,6} )/).map((section) => section.trim());
const headingsOf = (markdown: string) => markdown.split("\n").filter((line) => line.startsWith("#"));

const brand = { appName: "RealInfoBot", appUrl: "https://ca.realinfobot.com", folder: "screens" };

const team: HelpArticle = {
  slug: "team",
  title: "Team",
  section: "settings",
  summary: "Invite people to the business and choose what each can do.",
  screenPaths: ["/settings/team", "/settings/team/{memberId}"],
  location: ["Sidebar", "Settings", "Team"],
  access: "Owners and admins can invite people.",
  purpose: ["Everyone signs in with their own account."],
  areas: [{ name: "Members", description: "Everyone on the team, with their role." }],
  fields: [
    { title: "Team", fields: [{ name: "Email", requirement: "required", description: "Where the invitation goes." }, { name: "Role", requirement: "conditional", description: "Required for a new member." }] },
    { title: "Invite dialog", description: "Opens from **Invite**.", fields: [{ name: "Note", description: "Shown in the email." }] },
  ],
  tasks: [{ title: "Invite someone", steps: ["Select **Invite**.", "Enter their email address."] }, { title: "Connect Google Calendar", steps: ["Select **Connect**."] }],
  notes: ["An invitation link works for 7 days."],
  troubleshooting: [{ question: "The invitation didn't arrive. What can I check?", answer: "Check the spam folder." }],
  related: ["api-keys"],
  keywords: ["invite", "roles"],
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder like devops/kb/realinfobot, with help-kb.json and a manifest. */
function kbFolder(config: Record<string, unknown>, manifest = "knowledge:\n  files:\n    # screens:start\n    # screens:end\n"): string {
  const folder = mkdtempSync(join(tmpdir(), "help-kb-"));
  folders.push(folder);
  writeFileSync(join(folder, "help-kb.json"), JSON.stringify({ appName: "RealInfoBot", appUrl: "https://ca.realinfobot.com/", manifest: "kb.yaml", folder: "screens", ...config }));
  writeFileSync(join(folder, "kb.yaml"), manifest);
  return folder;
}

describe("splitSection", () => {
  it("keeps blocks that fit under one heading", () => {
    expect(splitSection("## Notes", ["- one", "- two"], "\n")).toEqual(["## Notes\n\n- one\n- two"]);
  });

  it("carries on under the heading again, marked (continued), when blocks don't fit", () => {
    const blocks = ["a", "b", "c", "d"].map((letter) => letter.repeat(600));
    const sections = splitSection("## Long", blocks);
    expect(sections.map((section) => section.split("\n")[0])).toEqual(["## Long", "## Long (continued)"]);
    expect(sections.join("")).toContain("d".repeat(600));
    for (const section of sections) expect(section.length).toBeLessThanOrEqual(SECTION_MAX_CHARACTERS);
  });

  it("leaves a block too long for a section whole", () => {
    expect(splitSection("## Huge", ["x".repeat(2_000)])).toEqual([`## Huge\n\n${"x".repeat(2_000)}`]);
  });
});

describe("screenGuide", () => {
  it("names the screen in every heading and leaves out Related help", () => {
    const guide = screenGuide(team, brand);
    expect(guide).toMatchObject({ slug: "team", path: "screens/team.md", title: "Screen guide: Team" });
    expect(headingsOf(guide.markdown)).toEqual([
      "# The Team screen in the RealInfoBot app",
      "## What the Team screen is for",
      "## What you see on the Team screen",
      "## The fields on the Team screen",
      "## Invite dialog, on the Team screen",
      "## How to invite someone, on the Team screen",
      "## How to connect Google Calendar, on the Team screen",
      "## Good to know about the Team screen",
      "## The invitation didn't arrive. What can I check? (Team screen)",
    ]);
    expect(guide.markdown).not.toMatch(/api-keys|Related/);
  });

  it("writes where the screen is, who can use it, and its addresses as links where they're fixed", () => {
    const { markdown } = screenGuide(team, brand);
    expect(markdown).toContain("Invite people to the business and choose what each can do.\n\n- Where to find it: Sidebar > Settings > Team\n- Who can use it: Owners and admins can invite people.\n- Address: https://ca.realinfobot.com/settings/team, `/settings/team/{memberId}`\n\nAlso known as: invite, roles.");
    expect(markdown).toContain("- **Email** (Required): Where the invitation goes.\n- **Role** (Sometimes required): Required for a new member.");
    expect(markdown).toContain("## Invite dialog, on the Team screen\n\nOpens from **Invite**.\n\n- **Note**: Shown in the email.");
    expect(markdown).toContain("1. Select **Invite**.\n2. Enter their email address.");
  });

  it("calls a setup step a setup step", () => {
    const step: HelpArticle = { ...team, slug: "onboarding-business", title: "First, what is the name of your business?", fields: [], tasks: [], troubleshooting: [{ question: "It won't go on.", answer: "Enter a name." }] };
    const guide = screenGuide(step, brand);
    expect(guide.title).toBe("Setup step guide: First, what is the name of your business?");
    expect(headingsOf(guide.markdown)).toContain('# The setup step "First, what is the name of your business?" in the RealInfoBot app');
    expect(headingsOf(guide.markdown)).toContain('## It won\'t go on. (setup step "First, what is the name of your business?")');
  });
});

describe("withScreensBlock", () => {
  const guides = [{ slug: "team", path: "screens/team.md", title: "Screen guide: Team", markdown: "" }];

  it("lists the guides between the markers, at the markers' indentation, and keeps the rest", () => {
    const manifest = "knowledge:\n  files:\n    # screens:start\n    - path: screens/old.md\n    # screens:end\n    - path: guides/01.md\n";
    expect(withScreensBlock(manifest, guides)).toBe('knowledge:\n  files:\n    # screens:start\n    - path: screens/team.md\n      title: "Screen guide: Team"\n    # screens:end\n    - path: guides/01.md\n');
  });

  it("refuses a manifest without the markers", () => {
    expect(() => withScreensBlock("knowledge:\n  files: []\n", guides, "kb.yaml")).toThrow('kb.yaml needs a "# screens:start" line');
  });
});

describe("a knowledge-base folder", () => {
  it("needs the brand's name, its address, the manifest and the folder", () => {
    const folder = kbFolder({ appName: " " });
    expect(() => readHelpKbConfig(folder)).toThrow("appName is missing");
  });

  it("refuses to skip a help page that doesn't exist", () => {
    expect(() => screenGuides({ ...readHelpKbConfig(kbFolder({})), skip: { "no-such-page": "Gone." } })).toThrow("help-kb.json skips no-such-page, which no help page is called");
  });

  it("writes a guide for every help page it doesn't skip, lists them in the manifest, and finds the guides no page writes", () => {
    const folder = kbFolder({ skip: { plan: "Not sold here." } });
    mkdirSync(join(folder, "screens"));
    writeFileSync(join(folder, "screens", "retired.md"), "# Old\n");
    const { files, stale } = helpKbOutputs(folder);
    expect(stale).toEqual(["screens/retired.md"]);
    expect(files.has("screens/team.md")).toBe(true);
    expect(files.has("screens/plan.md")).toBe(false);
    expect(files.get("kb.yaml")).toContain("    - path: screens/team.md\n");
    // The trailing slash of appUrl goes, so addresses have one slash.
    expect(files.get("screens/team.md")).toContain("https://ca.realinfobot.com/settings/team");
    expect(helpKbDrift(folder)).toEqual([...files.keys(), "screens/retired.md"]);
  });
});

describe.each(helpKbFolders())("%s", (folder) => {
  const config = readHelpKbConfig(folder);
  const manifest = readFileSync(join(folder, config.manifest), "utf8").replace(/\r\n/g, "\n");
  const listed = [...manifest.matchAll(/^\s*- path: (\S+)\s*$/gm)].map((match) => match[1]!);

  it("has the screen guides and the manifest's list of them up to date: run pnpm help:kb", () => {
    expect(helpKbDrift(folder)).toEqual([]);
  });

  it("lists every document in the folder once, in the manifest", () => {
    const documents = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => readdirSync(join(folder, entry.name)).filter((name) => name.endsWith(".md")).map((name) => `${entry.name}/${name}`));
    expect([...listed].sort()).toEqual([...documents].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it.runIf(existsSync(join(folder, "questions.yaml")))("tests its questions against documents the manifest lists", () => {
    const named = [...readFileSync(join(folder, "questions.yaml"), "utf8").matchAll(/answered_by: \[([^\]]*)\]/g)].flatMap((match) => match[1]!.split(",").map((path) => path.trim()));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((path) => !listed.includes(path))).toEqual([]);
  });

  it("keeps every section of every document within one passage of the knowledge base", () => {
    for (const path of listed) {
      for (const section of sectionsOf(readFileSync(join(folder, path), "utf8"))) {
        expect(section.length, `${path}: ${section.split("\n")[0]}`).toBeLessThanOrEqual(PASSAGE_CHARACTERS);
      }
    }
  });
});
