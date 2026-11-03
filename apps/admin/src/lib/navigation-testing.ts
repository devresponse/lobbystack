import { useMemo, useSyncExternalStore } from "react";
import { vi, type Mock } from "vitest";

// A stand-in for next/navigation in jsdom tests: an address whose path and
// query a test can set, and a router whose push and replace change it, so a
// component that keeps a filter in the address (?receptionist=<id>) re-renders
// as it would in the app. A test file uses it with
//   vi.mock("next/navigation", async () => (await import("@/lib/navigation-testing")).nextNavigationMock);
// and calls testNavigation.reset() before or after each test.

type Navigate = (url: string) => void;

export type TestRouter = {
  push: Mock<Navigate>;
  replace: Mock<Navigate>;
  refresh: Mock<() => void>;
  back: Mock<() => void>;
  prefetch: Mock<(url: string) => void>;
};

export type TestNavigation = {
  pathname: string;
  /** The query without its "?", such as "receptionist=…". */
  search: string;
  /** Moves to an address, as a link or the browser would. */
  set: Navigate;
  /** Back to an address with no query, for the next test. */
  reset: (pathname?: string) => void;
  router: TestRouter;
};

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function go(url: string) {
  const [pathname, search = ""] = url.split("?");
  if (pathname) testNavigation.pathname = pathname;
  testNavigation.search = search;
  listeners.forEach((listener) => listener());
}

export const testNavigation: TestNavigation = {
  pathname: "/",
  search: "",
  set: go,
  reset(pathname = "/") {
    testNavigation.pathname = pathname;
    testNavigation.search = "";
  },
  router: {
    push: vi.fn(go),
    replace: vi.fn(go),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  },
};

export const nextNavigationMock: {
  usePathname: () => string;
  useRouter: () => TestRouter;
  useSearchParams: () => URLSearchParams;
} = {
  usePathname: () => useSyncExternalStore(subscribe, () => testNavigation.pathname),
  useRouter: () => testNavigation.router,
  useSearchParams: () => {
    const search = useSyncExternalStore(subscribe, () => testNavigation.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  },
};
