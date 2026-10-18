import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentPageRoutes, referenceAppSource } from "./admin-ui-parity-check";
import { resolvePortVisualPath } from "./admin-ui-parity-routes";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

describe("currentPageRoutes", () => {
  it("normalizes route groups while preserving the locale segment", async () => {
    const root = await mkdtemp(join(tmpdir(), "admin-ui-parity-"));
    temporaryRoots.push(root);
    const routes = [
      "apps/admin/app/(public)/[locale]/login/page.tsx",
      "apps/admin/app/(sensitive)/[locale]/reset-password/[token]/page.tsx",
      "apps/admin/app/(dashboard)/settings/page.tsx",
    ];
    await Promise.all(routes.map(async (route) => {
      const path = join(root, route);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "export default function Page() { return null; }\n");
    }));

    await expect(currentPageRoutes(root)).resolves.toEqual([
      "/[locale]/login",
      "/[locale]/reset-password/[token]",
      "/settings",
    ]);
  });
});

describe("referenceAppSource", () => {
  it("reads the legacy route table at the reference commit, and nothing when the clone lacks it", async () => {
    const root = await mkdtemp(join(tmpdir(), "admin-ui-parity-git-"));
    temporaryRoots.push(root);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Parity", "-c", "user.email=parity@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
    git("init", "--quiet");
    await mkdir(join(root, "apps/web/src"), { recursive: true });
    await writeFile(join(root, "apps/web/src/App.tsx"), "<Route path=\"/calls\" />\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Legacy dashboard");
    const commit = git("rev-parse", "HEAD");

    expect(referenceAppSource(root, commit)).toBe("<Route path=\"/calls\" />\n");
    expect(referenceAppSource(root, "98df89901f1dca22b8c96ccf9509a8cd549f2eb9")).toBeNull();
  });
});

describe("resolvePortVisualPath", () => {
  const localizedRoutes = ["/[locale]/login", "/[locale]/demo/[token]"];

  it("expands localized static and dynamic port routes", () => {
    expect(resolvePortVisualPath("/login?returnTo=%2F", "fr", localizedRoutes)).toBe("/fr/login?returnTo=%2F");
    expect(resolvePortVisualPath("/demo/[demoToken]", "en", localizedRoutes)).toBe("/en/demo/[demoToken]");
  });

  it("leaves non-localized routes unchanged", () => {
    expect(resolvePortVisualPath("/analytics", "fr", localizedRoutes)).toBe("/analytics");
  });
});
